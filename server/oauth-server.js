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
const rawScopes = process.env.HUBSPOT_SCOPES || 'crm.objects.contacts.read crm.objects.contacts.write oauth';
const HUBSPOT_SCOPES = rawScopes
  .split(/\s+/)
  .filter(Boolean)
  .join(' ');

if (!HUBSPOT_CLIENT_ID || !HUBSPOT_CLIENT_SECRET || !HUBSPOT_SCOPES) {
  console.error('Missing required HubSpot environment variables. Please set: HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_SCOPES.');
  console.error('HUBSPOT_SCOPES must exactly match the scopes configured in your HubSpot app settings.');
  process.exit(1);
}

const storedStates = new Set();
let tokenPayload = null;

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
//   const params = new URLSearchParams({
//     client_id: HUBSPOT_CLIENT_ID,
//     redirect_uri: HUBSPOT_REDIRECT_URI,
//     scope: HUBSPOT_SCOPES,
//     response_type: 'code',
//     state,
//   });
const params = new URLSearchParams({
    client_id: HUBSPOT_CLIENT_ID,
    redirect_uri: HUBSPOT_REDIRECT_URI,
    scope: HUBSPOT_SCOPES
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

const handleStart = (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  storedStates.add(state);
  const redirect = buildHubSpotAuthorizeUrl(state);
  console.log('Generated OAuth URL:', redirect);
  console.log('State:', state);
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
    tokenPayload = tokenResponse;

    return sendHtml(
      res,
      200,
      `<h1>HubSpot OAuth Success</h1>
      <p>You are connected to HubSpot.</p>
      <pre>${JSON.stringify(tokenResponse, null, 2)}</pre>
      <p>Close this tab and return to your Wix app.</p>`
    );
  } catch (error) {
    return sendHtml(
      res,
      500,
      `<h1>HubSpot OAuth Token Exchange Failed</h1><pre>${error.message}</pre>`
    );
  }
};

const handleStatus = (res) => {
  if (!tokenPayload) {
    return sendJson(res, 200, { connected: false, message: 'No HubSpot connection available yet.' });
  }

  return sendJson(res, 200, {
    connected: true,
    tokenPayload,
  });
};

const handleApiFormsList = async (res) => {
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'Not authenticated' });
  }

  try {
    const formsData = await fetchHubSpotForms(tokenPayload.access_token);
    return sendJson(res, 200, { forms: formsData });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};

const handleApiFormEmbed = async (res, formId) => {
  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'Not authenticated' });
  }

  try {
    const embedCode = generateFormEmbed(formId);
    return sendJson(res, 200, {
      formId,
      embedCode,
      message: 'Form embed code generated successfully',
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
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

const handleWebhookFormSubmission = async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  if (!tokenPayload) {
    return sendJson(res, 401, { error: 'Not authenticated with HubSpot' });
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const formData = JSON.parse(body);
      console.log('Form submission received:', formData);

      const contactData = {
        email: formData.email || '',
        firstname: formData.firstname || formData.first_name || '',
        lastname: formData.lastname || formData.last_name || '',
        phone: formData.phone || '',
        message: formData.message || formData.comments || '',
      };

      const result = await createHubSpotContact(tokenPayload.access_token, contactData);
      console.log('Contact created in HubSpot:', result);

      return sendJson(res, 200, {
        success: true,
        message: 'Contact created in HubSpot',
        contactId: result.id,
      });
    } catch (error) {
      console.error('Form submission error:', error);
      return sendJson(res, 500, { error: error.message });
    }
  });
};

const requestHandler = async (req, res) => {
  const fullUrl = new URL(req.url, `http://${req.headers.host}`);

  if (fullUrl.pathname === '/auth/hubspot/start') {
    return handleStart(req, res);
  }

  if (fullUrl.pathname === '/auth/hubspot/callback') {
    return handleCallback(req, res, fullUrl);
  }

  if (fullUrl.pathname === '/auth/hubspot/status') {
    return handleStatus(res);
  }

  if (fullUrl.pathname === '/api/hubspot/forms') {
    return handleApiFormsList(res);
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