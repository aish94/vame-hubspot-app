const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envRaw = fs.readFileSync(envPath, 'utf8');
  envRaw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

const PORT = process.env.PORT || 3001;
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || `http://localhost:${PORT}/auth/hubspot/callback`;
const normalizeHubSpotScopes = (value) => {
  const raw = value || 'crm.objects.contacts.read crm.objects.contacts.write';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded
    .split(/[\s,+]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .join(' ');
};
const HUBSPOT_SCOPES = normalizeHubSpotScopes(process.env.HUBSPOT_SCOPES);

if (!HUBSPOT_CLIENT_ID || !HUBSPOT_CLIENT_SECRET || !HUBSPOT_SCOPES) {
  console.error('Missing required HubSpot environment variables. Please set: HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_SCOPES.');
  console.error('HUBSPOT_SCOPES must exactly match the scopes configured in your HubSpot app settings.');
  process.exit(1);
}

const storedStates = new Set();

// ══════════════════════════════════════════════════════
// Secure Token Storage — AES-256-GCM encrypted at rest
// ══════════════════════════════════════════════════════
const TOKEN_PATH = path.resolve(__dirname, '.token.enc');
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

// Safe structured logger — redacts tokens and PII from all log output
const REDACT_KEYS = new Set([
  'access_token', 'refresh_token', 'client_secret', 'authorization',
  'x-api-key', 'email', 'phone', 'firstname', 'lastname',
]);
const _sanitize = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : typeof v === 'object' ? _sanitize(v) : v,
    ])
  );
};
const log = {
  info:  (msg, data) => data ? console.log(`[INFO]  ${msg}`, _sanitize(data))  : console.log(`[INFO]  ${msg}`),
  warn:  (msg, data) => data ? console.warn(`[WARN]  ${msg}`, _sanitize(data))  : console.warn(`[WARN]  ${msg}`),
  error: (msg, data) => data ? console.error(`[ERROR] ${msg}`, _sanitize(data)) : console.error(`[ERROR] ${msg}`),
};

const _deriveKey = () =>
  crypto.scryptSync(
    process.env.TOKEN_ENCRYPTION_KEY || 'dev-key-CHANGE-IN-PRODUCTION',
    'vame-hubspot-app-salt-v1',
    32
  );

const encryptData = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: tag.toString('hex') });
};

const decryptData = (json) => {
  const { iv, data, tag } = JSON.parse(json);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _deriveKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(data, 'hex')).toString() + decipher.final('utf8');
};

const loadToken = () => {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(decryptData(fs.readFileSync(TOKEN_PATH, 'utf8')));
  } catch {
    return null;
  }
};

const saveToken = (tokenData) => {
  const withMeta = { ...tokenData, stored_at: Date.now() };
  fs.writeFileSync(TOKEN_PATH, encryptData(JSON.stringify(withMeta)), { mode: 0o600 });
  return withMeta;
};

const clearToken = () => {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
};

const _refreshHubSpotToken = (refreshToken) =>
  new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString();
    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path: '/oauth/v1/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            res.statusCode >= 200 && res.statusCode < 300
              ? resolve(json)
              : reject(new Error(`Token refresh failed (${res.statusCode})`));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });

const getValidToken = async () => {
  const token = loadToken();
  if (!token) throw new Error('Not authenticated with HubSpot. Connect via /auth/hubspot/start');
  const expiresAt = (token.stored_at || 0) + (token.expires_in || 1800) * 1000;
  if (Date.now() < expiresAt - 5 * 60 * 1000) return token;
  if (!token.refresh_token) throw new Error('HubSpot token expired. Please reconnect.');
  log.info('Refreshing HubSpot access token');
  const refreshed = await _refreshHubSpotToken(token.refresh_token);
  const saved = saveToken(refreshed);
  // eslint-disable-next-line no-use-before-define
  tokenPayload = saved;
  return saved;
};

const isApiKeyValid = (req) => {
  if (!SYNC_API_KEY) return true;
  const key =
    req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return key === SYNC_API_KEY;
};

let tokenPayload = loadToken();

const STORE_PATH = path.resolve(__dirname, 'sync-store.json');
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_SYNC_CONFIG = {
  conflictRule: 'last-updated-wins',
  prioritySource: 'hubspot',
  mappings: [
    {
      id: 'default-email',
      wixField: 'email',
      hubspotProperty: 'email',
      syncDirection: 'bidirectional',
      transform: 'none',
    },
    {
      id: 'default-phone',
      wixField: 'phone',
      hubspotProperty: 'phone',
      syncDirection: 'bidirectional',
      transform: 'none',
    },
    {
      id: 'default-firstname',
      wixField: 'firstName',
      hubspotProperty: 'firstname',
      syncDirection: 'bidirectional',
      transform: 'none',
    },
    {
      id: 'default-lastname',
      wixField: 'lastName',
      hubspotProperty: 'lastname',
      syncDirection: 'bidirectional',
      transform: 'none',
    },
  ],
};

const syncState = {
  config: { ...DEFAULT_SYNC_CONFIG },
  links: [],
  wixContacts: {},
};

const dedupeCache = new Map();

const loadSyncState = () => {
  if (!fs.existsSync(STORE_PATH)) {
    return;
  }

  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    syncState.config = {
      ...DEFAULT_SYNC_CONFIG,
      ...(parsed.config || {}),
      mappings: Array.isArray(parsed.config?.mappings) && parsed.config.mappings.length > 0
        ? parsed.config.mappings
        : DEFAULT_SYNC_CONFIG.mappings,
    };
    syncState.links = Array.isArray(parsed.links) ? parsed.links : [];
    syncState.wixContacts = parsed.wixContacts && typeof parsed.wixContacts === 'object'
      ? parsed.wixContacts
      : {};
  } catch (error) {
    console.error('Failed to load sync state, using defaults:', error.message);
  }
};

const persistSyncState = () => {
  const safe = JSON.stringify(
    {
      config: syncState.config,
      links: syncState.links,
      wixContacts: syncState.wixContacts,
    },
    null,
    2
  );
  fs.writeFileSync(STORE_PATH, safe, 'utf8');
};

const cleanupDedupeCache = () => {
  const now = Date.now();
  for (const [key, value] of dedupeCache.entries()) {
    if (now - value.ts > DEDUPE_WINDOW_MS) {
      dedupeCache.delete(key);
    }
  }
};

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const parseJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (error) => reject(error));
  });

const applyTransform = (value, transform) => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'string') {
    return value;
  }
  if (transform === 'trim') {
    return value.trim();
  }
  if (transform === 'lowercase') {
    return value.toLowerCase();
  }
  if (transform === 'uppercase') {
    return value.toUpperCase();
  }
  return value;
};

const normalizeWixContact = (payload = {}) => {
  const fields = payload.fields || payload;
  const firstName = fields.firstName || fields.firstname || fields.first_name || fields.name || '';
  const lastName = fields.lastName || fields.lastname || fields.last_name || '';

  return {
    id: payload.id || payload.wixContactId || fields.id || '',
    email: normalizeEmail(fields.email || payload.email || ''),
    updatedAt: payload.updatedAt || fields.updatedAt || new Date().toISOString(),
    fields: {
      ...fields,
      firstName,
      lastName,
      email: normalizeEmail(fields.email || payload.email || ''),
      phone: fields.phone || '',
    },
  };
};

const normalizeHubSpotContact = (payload = {}) => {
  const properties = payload.properties || payload;
  return {
    id: payload.id || payload.hubspotContactId || '',
    email: normalizeEmail(properties.email || payload.email || ''),
    updatedAt:
      payload.updatedAt ||
      properties.lastmodifieddate ||
      properties.hs_lastmodifieddate ||
      new Date().toISOString(),
    fields: {
      ...properties,
      email: normalizeEmail(properties.email || payload.email || ''),
      firstname: properties.firstname || '',
      lastname: properties.lastname || '',
      phone: properties.phone || '',
    },
  };
};

const mappingAppliesForDirection = (syncDirection, source, target) => {
  if (syncDirection === 'bidirectional') {
    return true;
  }
  if (syncDirection === 'wix-to-hubspot' && source === 'wix' && target === 'hubspot') {
    return true;
  }
  if (syncDirection === 'hubspot-to-wix' && source === 'hubspot' && target === 'wix') {
    return true;
  }
  return false;
};

const buildMappedPayload = (source, target, sourceContact, mappings) => {
  const output = {};
  for (const mapping of mappings) {
    if (!mappingAppliesForDirection(mapping.syncDirection, source, target)) {
      continue;
    }

    const fromKey = source === 'wix' ? mapping.wixField : mapping.hubspotProperty;
    const toKey = target === 'wix' ? mapping.wixField : mapping.hubspotProperty;
    const rawValue = sourceContact.fields[fromKey];

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      continue;
    }

    output[toKey] = applyTransform(rawValue, mapping.transform || 'none');
  }
  return output;
};

const hashObject = (value) => {
  const stable = JSON.stringify(value, Object.keys(value).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
};

const findLink = ({ wixContactId, hubspotContactId, email }) => {
  const normalizedEmail = normalizeEmail(email);
  return syncState.links.find(
    (link) =>
      (wixContactId && link.wixContactId && link.wixContactId === wixContactId) ||
      (hubspotContactId && link.hubspotContactId && link.hubspotContactId === hubspotContactId) ||
      (normalizedEmail && link.email && link.email === normalizedEmail)
  );
};

const upsertLink = ({ wixContactId, hubspotContactId, email, source, syncId }) => {
  let link = findLink({ wixContactId, hubspotContactId, email });
  if (!link) {
    link = {
      wixContactId: wixContactId || null,
      hubspotContactId: hubspotContactId || null,
      email: normalizeEmail(email) || null,
      lastSyncAt: new Date().toISOString(),
      lastSource: source,
      lastSyncId: syncId,
      hashes: {
        wix: null,
        hubspot: null,
      },
    };
    syncState.links.push(link);
    return link;
  }

  if (wixContactId) {
    link.wixContactId = wixContactId;
  }
  if (hubspotContactId) {
    link.hubspotContactId = hubspotContactId;
  }
  if (email) {
    link.email = normalizeEmail(email);
  }
  link.lastSyncAt = new Date().toISOString();
  link.lastSource = source;
  link.lastSyncId = syncId;
  if (!link.hashes) {
    link.hashes = { wix: null, hubspot: null };
  }
  return link;
};

const shouldSkipByConflictRule = (source, incomingTimestamp, link) => {
  const incomingTime = new Date(incomingTimestamp || 0).getTime();
  const previousTime = new Date(link?.lastSyncAt || 0).getTime();

  if (syncState.config.conflictRule === 'source-priority') {
    return syncState.config.prioritySource !== source;
  }

  return Number.isFinite(previousTime) && previousTime > incomingTime;
};

const hubspotRequest = ({ method, path, accessToken, payload }) =>
  new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : {};
          } catch (error) {
            return reject(new Error(`Failed to parse HubSpot response: ${data}`));
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`HubSpot API ${method} ${path} failed (${res.statusCode}): ${data}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (body) {
      req.write(body);
    }
    req.end();
  });

const upsertHubSpotContact = async ({ hubspotContactId, email, properties }) => {
  const token = await getValidToken();

  if (hubspotContactId) {
    const updated = await hubspotRequest({
      method: 'PATCH',
      path: `/crm/v3/objects/contacts/${encodeURIComponent(hubspotContactId)}`,
      accessToken: token.access_token,
      payload: { properties },
    });
    return { id: updated.id || hubspotContactId, properties: updated.properties || properties, mode: 'updated' };
  }

  const normalizedEmail = normalizeEmail(email || properties.email || '');
  if (normalizedEmail) {
    const search = await hubspotRequest({
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
      accessToken: token.access_token,
      payload: {
        filterGroups: [
          {
            filters: [
              { propertyName: 'email', operator: 'EQ', value: normalizedEmail },
            ],
          },
        ],
        properties: ['email', 'firstname', 'lastname', 'phone', 'lastmodifieddate'],
        limit: 1,
      },
    });

    if (Array.isArray(search.results) && search.results.length > 0) {
      const existingId = search.results[0].id;
      const updated = await hubspotRequest({
        method: 'PATCH',
        path: `/crm/v3/objects/contacts/${encodeURIComponent(existingId)}`,
        accessToken: token.access_token,
        payload: { properties },
      });
      return { id: updated.id || existingId, properties: updated.properties || properties, mode: 'updated' };
    }
  }

  const created = await hubspotRequest({
    method: 'POST',
    path: '/crm/v3/objects/contacts',
    accessToken: token.access_token,
    payload: { properties },
  });

  return { id: created.id, properties: created.properties || properties, mode: 'created' };
};

const upsertWixContact = async ({ wixContactId, email, fields, meta }) => {
  const targetWebhook = process.env.WIX_CONTACTS_WEBHOOK_URL;
  const contactId = wixContactId || `wix-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const contact = {
    id: contactId,
    email: normalizeEmail(email || fields.email || ''),
    updatedAt: new Date().toISOString(),
    fields: {
      ...fields,
      email: normalizeEmail(email || fields.email || ''),
    },
  };

  syncState.wixContacts[contactId] = contact;

  if (targetWebhook) {
    const body = JSON.stringify({
      contact,
      source: 'sync-engine',
      syncId: meta.syncId,
      correlationId: meta.correlationId,
    });

    await new Promise((resolve, reject) => {
      const parsed = new URL(targetWebhook);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data || '{}');
            } else {
              reject(new Error(`Wix contacts webhook failed (${res.statusCode}): ${data}`));
            }
          });
        }
      );
      req.on('error', (error) => reject(error));
      req.write(body);
      req.end();
    });
  }

  return { id: contactId, fields: contact.fields, mode: wixContactId ? 'updated' : 'created' };
};

const processSyncEvent = async ({ source, eventType, contact, sourceMeta }) => {
  const target = source === 'wix' ? 'hubspot' : 'wix';
  const normalizedContact = source === 'wix' ? normalizeWixContact(contact) : normalizeHubSpotContact(contact);
  const syncId = sourceMeta.syncId || crypto.randomUUID();
  const correlationId = sourceMeta.correlationId || syncId;
  const dedupeKey = `${source}:${eventType}:${sourceMeta.eventId || normalizedContact.id || normalizedContact.email}:${normalizedContact.updatedAt}`;

  cleanupDedupeCache();
  if (dedupeCache.has(dedupeKey)) {
    return { skipped: true, reason: 'duplicate-event', syncId, correlationId };
  }

  dedupeCache.set(dedupeKey, { ts: Date.now() });

  if (sourceMeta.origin === 'sync-engine') {
    return { skipped: true, reason: 'own-write', syncId, correlationId };
  }

  const existingLink = findLink({
    wixContactId: source === 'wix' ? normalizedContact.id : undefined,
    hubspotContactId: source === 'hubspot' ? normalizedContact.id : undefined,
    email: normalizedContact.email,
  });

  if (existingLink && shouldSkipByConflictRule(source, normalizedContact.updatedAt, existingLink)) {
    return { skipped: true, reason: 'conflict-rule', syncId, correlationId };
  }

  const mappedTargetFields = buildMappedPayload(source, target, normalizedContact, syncState.config.mappings || []);
  if (Object.keys(mappedTargetFields).length === 0) {
    return { skipped: true, reason: 'no-applicable-mappings', syncId, correlationId };
  }

  const payloadHash = hashObject(mappedTargetFields);
  if (existingLink?.hashes?.[target] && existingLink.hashes[target] === payloadHash) {
    return { skipped: true, reason: 'idempotent-no-change', syncId, correlationId };
  }

  let targetResult;
  if (target === 'hubspot') {
    targetResult = await upsertHubSpotContact({
      hubspotContactId: existingLink?.hubspotContactId || null,
      email: normalizedContact.email,
      properties: mappedTargetFields,
    });
  } else {
    targetResult = await upsertWixContact({
      wixContactId: existingLink?.wixContactId || null,
      email: normalizedContact.email,
      fields: mappedTargetFields,
      meta: {
        syncId,
        correlationId,
      },
    });
  }

  const link = upsertLink({
    wixContactId: source === 'wix' ? normalizedContact.id : target === 'wix' ? targetResult.id : existingLink?.wixContactId,
    hubspotContactId:
      source === 'hubspot' ? normalizedContact.id : target === 'hubspot' ? targetResult.id : existingLink?.hubspotContactId,
    email: normalizedContact.email,
    source,
    syncId,
  });

  link.hashes[target] = payloadHash;
  link.lastSyncAt = new Date().toISOString();
  persistSyncState();

  return {
    skipped: false,
    syncId,
    correlationId,
    source,
    target,
    mode: targetResult.mode,
    link,
    targetContactId: targetResult.id,
  };
};

loadSyncState();

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const sendHtml = (res, status, html) => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
};

const buildHubSpotAuthorizeUrl = (state) => {
  const params = new URLSearchParams({
    client_id: HUBSPOT_CLIENT_ID,
    redirect_uri: HUBSPOT_REDIRECT_URI,
    scope: HUBSPOT_SCOPES,
    response_type: 'code',
    state,
  });


  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
};

const exchangeCodeForToken = (code) => {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code,
    }).toString();

    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path: '/oauth/v1/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`HubSpot token endpoint returned status ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
};

const fetchHubSpotForms = (accessToken) => {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/forms?limit=100',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const forms = (json.results || []).map((form) => ({
                id: form.id,
                name: form.properties?.name?.value || form.id,
              }));
              resolve(forms);
            } else {
              reject(
                new Error(
                  `HubSpot forms endpoint returned status ${res.statusCode}: ${data}`
                )
              );
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.end();
  });
};

const generateFormEmbed = (formId) => {
  const script = `
<script charset="utf-8" src="https://js.hsforms.net/forms/v2.js"><\/script>
<script>
  hbspt.forms.create({
    region: 'na1',
    portalId: 'YOUR_PORTAL_ID',
    formId: '${formId}'
  });
<\/script>
<div id="hubspot-form-${formId}"><\/div>
  `.trim();
  return script;
};

const handleStart = (req, res, fullUrl) => {
  const state = crypto.randomBytes(16).toString('hex');
  storedStates.add(state);
  const requestedScope = fullUrl?.searchParams?.get('scope') || '';
  const scopeToUse = normalizeHubSpotScopes(requestedScope || HUBSPOT_SCOPES);
  const redirect = buildHubSpotAuthorizeUrl(state, scopeToUse);
  log.info('Initiating HubSpot OAuth flow', { scope: scopeToUse });
  res.writeHead(302, { Location: redirect });
  res.end();
};

const handleCallback = async (req, res, url) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state || !storedStates.has(state)) {
    return sendHtml(
      res,
      400,
      `<h1>HubSpot OAuth Error</h1><p>Invalid callback request. Missing code or invalid state.</p>`
    );
  }

  storedStates.delete(state);

  try {
    const tokenResponse = await exchangeCodeForToken(code);
    tokenPayload = saveToken(tokenResponse);
    log.info('HubSpot OAuth connection established');

    return sendHtml(
      res,
      200,
      `<!DOCTYPE html><html><head><title>HubSpot Connected</title></head><body>
      <h1>&#x2705; HubSpot Connected Successfully</h1>
      <p>Your HubSpot account is now connected to Vame-HubSpotApp.</p>
      <p>You can close this tab and return to your Wix dashboard.</p>
      </body></html>`
    );
  } catch (error) {
    log.error('HubSpot OAuth token exchange failed', { message: error.message });
    return sendHtml(
      res,
      500,
      `<h1>Connection Failed</h1><p>${error.message}</p>`
    );
  }
};

const handleStatus = (res) => {
  const token = loadToken();
  if (!token) {
    return sendJson(res, 200, { connected: false });
  }
  const expiresAt = (token.stored_at || 0) + (token.expires_in || 1800) * 1000;
  return sendJson(res, 200, {
    connected: true,
    connectedAt: token.stored_at || null,
    expiresAt,
    tokenExpired: Date.now() > expiresAt,
  });
};

const handleApiFormsList = async (res) => {
  try {
    const token = await getValidToken();
    const formsData = await fetchHubSpotForms(token.access_token);
    return sendJson(res, 200, { forms: formsData });
  } catch (error) {
    return sendJson(res, error.message.includes('authenticated') ? 401 : 500, { error: error.message });
  }
};

const handleApiFormEmbed = async (res, formId) => {
  try {
    await getValidToken();
    const embedCode = generateFormEmbed(formId);
    return sendJson(res, 200, { formId, embedCode });
  } catch (error) {
    return sendJson(res, error.message.includes('authenticated') ? 401 : 500, { error: error.message });
  }
};

const createHubSpotContact = (accessToken, contactData) => {
  return new Promise((resolve, reject) => {
    const properties = [];
    
    if (contactData.email) {
      properties.push({ property: 'email', value: contactData.email });
    }
    if (contactData.firstname) {
      properties.push({ property: 'firstname', value: contactData.firstname });
    }
    if (contactData.lastname) {
      properties.push({ property: 'lastname', value: contactData.lastname });
    }
    if (contactData.phone) {
      properties.push({ property: 'phone', value: contactData.phone });
    }
    if (contactData.message) {
      properties.push({ property: 'message', value: contactData.message });
    }

    const body = JSON.stringify({ properties });

    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/contacts',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`HubSpot contact creation failed: ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
};

// ═══ UTM / Attribution HubSpot property helpers ═══
let _utmPropertiesEnsured = false;

const UTM_HUBSPOT_PROPERTIES = [
  { name: 'utm_source',               label: 'UTM Source' },
  { name: 'utm_medium',               label: 'UTM Medium' },
  { name: 'utm_campaign',             label: 'UTM Campaign' },
  { name: 'utm_term',                 label: 'UTM Term' },
  { name: 'utm_content',              label: 'UTM Content' },
  { name: 'lead_source_url',          label: 'Lead Source URL' },
  { name: 'lead_referrer',            label: 'Lead Referrer' },
  { name: 'last_form_submission_at',  label: 'Last Form Submission At' },
];

const ensureHubSpotProperty = async (accessToken, name, label) => {
  try {
    await hubspotRequest({
      method: 'POST',
      path: '/crm/v3/properties/contacts',
      accessToken,
      payload: {
        name,
        label,
        type: 'string',
        fieldType: 'text',
        groupName: 'contactinformation',
        description: 'Auto-created by Vame-HubSpotApp for UTM attribution tracking',
      },
    });
  } catch (error) {
    // 409 = property already exists — safe to ignore
    if (!error.message.includes('409') && !error.message.includes('already exists')) {
      log.warn(`Could not ensure HubSpot property "${name}"`, { message: error.message });
    }
  }
};

const ensureUtmProperties = async (accessToken) => {
  if (_utmPropertiesEnsured) return;
  await Promise.all(
    UTM_HUBSPOT_PROPERTIES.map(({ name, label }) => ensureHubSpotProperty(accessToken, name, label))
  );
  _utmPropertiesEnsured = true;
};

const handleDisconnect = (req, res) => {
  clearToken();
  tokenPayload = null;
  _utmPropertiesEnsured = false;
  log.info('HubSpot account disconnected by user');
  return sendJson(res, 200, { success: true, message: 'Disconnected from HubSpot' });
};

const handleSyncConfigGet = (res) => {
  return sendJson(res, 200, {
    config: syncState.config,
  });
};

const handleSyncConfigPut = async (req, res) => {
  if (req.method !== 'PUT') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await parseJsonBody(req);
    const mappings = Array.isArray(body.mappings) ? body.mappings : [];
    const conflictRule = body.conflictRule === 'source-priority' ? 'source-priority' : 'last-updated-wins';
    const prioritySource = body.prioritySource === 'wix' ? 'wix' : 'hubspot';

    syncState.config = {
      ...syncState.config,
      mappings,
      conflictRule,
      prioritySource,
    };
    persistSyncState();

    return sendJson(res, 200, {
      success: true,
      config: syncState.config,
    });
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
};

const handleSyncLinksGet = (res) => {
  return sendJson(res, 200, {
    links: syncState.links,
  });
};

const handleSyncEvent = async (req, res, source) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await parseJsonBody(req);
    const result = await processSyncEvent({
      source,
      eventType: body.eventType || 'update',
      contact: body.contact || body,
      sourceMeta: {
        syncId: body.syncId,
        correlationId: body.correlationId,
        eventId: body.eventId,
        origin: body.origin,
      },
    });
    return sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(`Sync event error (${source}):`, error);
    return sendJson(res, 500, {
      success: false,
      error: error.message,
    });
  }
};

const handleWebhookFormSubmission = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const formData = await parseJsonBody(req);
    const attribution = formData.attribution || {};

    // Build HubSpot properties from submitted form fields
    const properties = {};
    if (formData.firstname || formData.first_name || formData.name) {
      properties.firstname = formData.firstname || formData.first_name || formData.name;
    }
    if (formData.lastname || formData.last_name) {
      properties.lastname = formData.lastname || formData.last_name;
    }
    if (formData.email)   properties.email   = normalizeEmail(formData.email);
    if (formData.phone)   properties.phone   = formData.phone;
    if (formData.company) properties.company = formData.company;
    if (formData.message) properties.message = formData.message;

    // UTM attribution — stored as custom HubSpot contact properties
    // See UTM_HUBSPOT_PROPERTIES for the full list of custom properties created
    if (attribution.utm_source)   properties.utm_source   = attribution.utm_source;
    if (attribution.utm_medium)   properties.utm_medium   = attribution.utm_medium;
    if (attribution.utm_campaign) properties.utm_campaign = attribution.utm_campaign;
    if (attribution.utm_term)     properties.utm_term     = attribution.utm_term;
    if (attribution.utm_content)  properties.utm_content  = attribution.utm_content;
    if (attribution.source_url)   properties.lead_source_url = attribution.source_url;
    if (attribution.referrer)     properties.lead_referrer   = attribution.referrer;
    properties.last_form_submission_at = attribution.submitted_at || new Date().toISOString();

    const token = await getValidToken();
    await ensureUtmProperties(token.access_token);

    const result = await upsertHubSpotContact({
      hubspotContactId: null,
      email: formData.email,
      properties,
    });

    log.info('Form submission synced to HubSpot', { mode: result.mode });

    return sendJson(res, 200, {
      success: true,
      message: `Contact ${result.mode} in HubSpot`,
      contactId: result.id,
      mode: result.mode,
    });
  } catch (error) {
    log.error('Form submission error', { message: error.message });
    if (/Not authenticated with HubSpot/i.test(error.message)) {
      return sendJson(res, 401, {
        error: error.message,
        requiresAuth: true,
        connectUrl: '/auth/hubspot/start',
      });
    }
    if (/MISSING_SCOPES|required scopes/i.test(error.message)) {
      return sendJson(res, 403, {
        error: 'HubSpot app is connected, but missing required write scopes for contact submission.',
        details: error.message,
        requiresReauth: true,
        hint: 'Enable contacts write + sensitive/highly-sensitive write scopes in your HubSpot app, then reconnect.',
      });
    }
    return sendJson(res, 500, { error: error.message });
  }
};

const requestHandler = async (req, res) => {
  const fullUrl = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Key');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (fullUrl.pathname === '/auth/hubspot/start') {
    return handleStart(req, res, fullUrl);
  }

  if (fullUrl.pathname === '/auth/hubspot/callback') {
    return handleCallback(req, res, fullUrl);
  }

  if (fullUrl.pathname === '/auth/hubspot/status') {
    return handleStatus(res);
  }

  if (fullUrl.pathname === '/auth/hubspot/disconnect' && req.method === 'POST') {
    if (!isApiKeyValid(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return handleDisconnect(req, res);
  }

  if (fullUrl.pathname === '/api/hubspot/forms') {
    return handleApiFormsList(res);
  }

  if (fullUrl.pathname === '/api/sync/config' && req.method === 'GET') {
    return handleSyncConfigGet(res);
  }

  if (fullUrl.pathname === '/api/sync/config' && req.method === 'PUT') {
    if (!isApiKeyValid(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return handleSyncConfigPut(req, res);
  }

  if (fullUrl.pathname === '/api/sync/links' && req.method === 'GET') {
    if (!isApiKeyValid(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return handleSyncLinksGet(res);
  }

  if (fullUrl.pathname === '/webhook/wix/contact') {
    if (!isApiKeyValid(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return handleSyncEvent(req, res, 'wix');
  }

  if (fullUrl.pathname === '/webhook/hubspot/contact') {
    if (!isApiKeyValid(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return handleSyncEvent(req, res, 'hubspot');
  }

  if (fullUrl.pathname.startsWith('/api/hubspot/forms/') && fullUrl.pathname.endsWith('/embed')) {
    const formId = fullUrl.pathname.match(/\/api\/hubspot\/forms\/(.+)\/embed/)?.[1];
    if (formId) {
      return handleApiFormEmbed(res, formId);
    }
  }

  if (fullUrl.pathname === '/webhook/form-submission') {
    return handleWebhookFormSubmission(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
};

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });
});

server.listen(PORT, () => {
  console.log(`HubSpot OAuth server listening at http://localhost:${PORT}`);
  console.log(`Start OAuth by opening http://localhost:${PORT}/auth/hubspot/start`);
});
// let tokenPayload = null;

// const handleApiFormsList = async (res) => {
//   if (!tokenPayload) {
//     return sendJson(res, 401, { error: 'Not authenticated' });
//   }

//   try {
//     const formsData = await fetchHubSpotForms(tokenPayload.access_token);
//     return sendJson(res, 200, { forms: formsData });
//   } catch (error) {
//     return sendJson(res, 500, { error: error.message });
//   }
// };

// const handleApiFormEmbed = async (res, formId) => {
//   if (!tokenPayload) {
//     return sendJson(res, 401, { error: 'Not authenticated' });
//   }

//   try {
//     const embedCode = generateFormEmbed(formId);
//     return sendJson(res, 200, {
//       formId,
//       embedCode,
//       message: 'Form embed code generated successfully',
//     });
//   } catch (error) {
//     return sendJson(res, 500, { error: error.message });
//   }
// };

// const fetchHubSpotForms = (accessToken) => {
//   return new Promise((resolve, reject) => {
//     const req = https.request(
//       {
//         hostname: 'api.hubapi.com',
//         path: '/crm/v3/objects/forms?limit=100',
//         method: 'GET',
//         headers: {
//           Authorization: `Bearer ${accessToken}`,
//           'Content-Type': 'application/json',
//         },
//       },
//       (res) => {
//         let data = '';
//         res.on('data', (chunk) => {
//           data += chunk;
//         });
//         res.on('end', () => {
//           try {
//             const json = JSON.parse(data);
//             if (res.statusCode >= 200 && res.statusCode < 300) {
//               const forms = (json.results || []).map((form) => ({
//                 id: form.id,
//                 name: form.properties?.name?.value || form.id,
//               }));
//               resolve(forms);
//             } else {
//               reject(
//                 new Error(
//                   `HubSpot forms endpoint returned status ${res.statusCode}: ${data}`
//                 )
//               );
//             }
//           } catch (error) {
//             reject(error);
//           }
//         });
//       }
//     );

//     req.on('error', (err) => reject(err));
//     req.end();
//   });
// };

// const generateFormEmbed = (formId) => {
//   const script = `
// <script charset="utf-8" src="https://js.hsforms.net/forms/v2.js"><\/script>
// <script>
//   hbspt.forms.create({
//     region: 'na1',
//     portalId: 'YOUR_PORTAL_ID',
//     formId: '${formId}'
//   });
// <\/script>
// <div id="hubspot-form-${formId}"><\/div>
//   `.trim();
//   return script;
// };
//   const body = JSON.stringify(payload, null, 2);
//   res.writeHead(status, {
//     'Content-Type': 'application/json',
//     'Content-Length': Buffer.byteLength(body),
//   });
//   res.end(body);
// };

// const sendHtml = (res, status, html) => {
//   res.writeHead(status, {
//     'Content-Type': 'text/html; charset=utf-8',
//     'Content-Length': Buffer.byteLength(html),
//   });
//   res.end(html);
// };

// const buildHubSpotAuthorizeUrl = (state) => {
//   const params = new URLSearchParams({
//     client_id: HUBSPOT_CLIENT_ID,
//     redirect_uri: HUBSPOT_REDIRECT_URI,
//     scope: HUBSPOT_SCOPES,
//     response_type: 'code',
//     state,
//   });

//   return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
// };

// const exchangeCodeForToken = (code) => {
//   return new Promise((resolve, reject) => {
//     const body = new URLSearchParams({
//       grant_type: 'authorization_code',
//       client_id: HUBSPOT_CLIENT_ID,
//       client_secret: HUBSPOT_CLIENT_SECRET,
//       redirect_uri: HUBSPOT_REDIRECT_URI,
//       code,
//     }).toString();

//     const req = https.request(
//       {
//         hostname: 'api.hubapi.com',
//         path: '/oauth/v1/token',
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/x-www-form-urlencoded',
//           'Content-Length': Buffer.byteLength(body),
//         },
//       },
//       (res) => {
//         let data = '';
//         res.on('data', (chunk) => {
//           data += chunk;
//         });
//         res.on('end', () => {
//           try {
//             const json = JSON.parse(data);
//             if (res.statusCode >= 200 && res.statusCode < 300) {
//               resolve(json);
//             } else {
//               reject(new Error(`HubSpot token endpoint returned status ${res.statusCode}: ${data}`));
//             }
//           } catch (error) {
//             reject(error);
//           }
//         });
//       }
//     );

//     req.on('error', (err) => reject(err));
//     req.write(body);
//     req.end();
//   });
// };

// const handleStart = (req, res) => {
//   const state = crypto.randomBytes(16).toString('hex');
//   storedStates.add(state);
//   const redirect = buildHubSpotAuthorizeUrl(state);
//   res.writeHead(302, { Location: redirect });
//   res.end();
// };

// const handleCallback = async (req, res, url) => {
//   const code = url.searchParams.get('code');
//   const state = url.searchParams.get('state');

//   if (!code || !state || !storedStates.has(state)) {
//     return sendHtml(
//       res,
//       400,
//       `<h1>HubSpot OAuth Error</h1><p>Invalid callback request. Missing code or invalid state.</p>`
//     );
//   }

//   storedStates.delete(state);

//   try {
//     const tokenResponse = await exchangeCodeForToken(code);
//     tokenPayload = tokenResponse;

//     return sendHtml(
//       res,
//       200,
//       `<h1>HubSpot OAuth Success</h1>
//       <p>You are connected to HubSpot.</p>
//       <pre>${JSON.stringify(tokenResponse, null, 2)}</pre>
//       <p>Close this tab and return to your Wix app.</p>`
//     );
//   } catch (error) {
//     return sendHtml(
//       res,
//       500,
//       `<h1>HubSpot OAuth Token Exchange Failed</h1><pre>${error.message}</pre>`
//     );
//   }
// };

// const handleStatus = (res) => {
//   if (!tokenPayload) {
//     return sendJson(res, 200, { connected: false, message: 'No HubSpot connection available yet.' });
//   }

//   return sendJson(res, 200, {
//     connected: true,
//     tokenPayload,
//   });
// };

// const requestHandler = async (req, res, url) => {
//   const fullUrl = new URL(req.url, `http://${req.headers.host}`);

//   if (fullUrl.pathname === '/auth/hubspot/start') {
//     return handleStart(req, res);
//   }

//   if (fullUrl.pathname === '/auth/hubspot/callback') {
//     return handleCallback(req, res, fullUrl);
//   }

//   if (fullUrl.pathname === '/auth/hubspot/status') {
//     return handleStatus(res);
//   }

//   if (fullUrl.pathname === '/api/hubspot/forms') {
//     return handleApiFormsList(res);
//   }

//   if (fullUrl.pathname.startsWith('/api/hubspot/forms/') && fullUrl.pathname.endsWith('/embed')) {
//     const formId = fullUrl.pathname.match(/\/api\/hubspot\/forms\/(.+)\/embed/)?.[1];
//     if (formId) {
//       return handleApiFormEmbed(res, formId);
//     }
//   }

//   res.writeHead(404, { 'Content-Type': 'text/plain' });
//   res.end('Not Found');
// };


// const server = http.createServer((req, res) => {
//   requestHandler(req, res).catch((error) => {
//     console.error('Server error:', error);
//     res.writeHead(500, { 'Content-Type': 'text/plain' });
//     res.end('Internal Server Error');
//   });
// });

// server.listen(PORT, () => {
//   console.log(`HubSpot OAuth server listening at http://localhost:${PORT}`);
//   console.log(`Start OAuth by opening http://localhost:${PORT}/auth/hubspot/start`);
// });