import React, { useEffect, useState } from 'react';
import {
  Box,
  Text,
  Button,
  IconButton,
  Card,
  Tooltip,
} from '@wix/design-system';
import * as Icons from '@wix/wix-ui-icons-common';
import { SYNC_CONFIG_URL } from '../../config';

interface FieldMapping {
  id: string;
  wixField: string;
  hubspotProperty: string;
  syncDirection: 'wix-to-hubspot' | 'hubspot-to-wix' | 'bidirectional';
  transform?: 'trim' | 'lowercase' | 'uppercase' | 'none';
}

interface FieldMappingTableProps {
  onSave?: (payload: SyncConfigPayload) => void;
  initialMappings?: FieldMapping[];
}

interface SyncConfigPayload {
  mappings: FieldMapping[];
  conflictRule: 'last-updated-wins' | 'source-priority';
  prioritySource: 'hubspot' | 'wix';
}

// Mock data - in production, fetch from backend
const WIX_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'address', label: 'Address' },
  { value: 'city', label: 'City' },
  { value: 'country', label: 'Country' },
  { value: 'company', label: 'Company' },
  { value: 'jobTitle', label: 'Job Title' },
];

const HUBSPOT_PROPERTIES = [
  { value: 'firstname', label: 'First Name' },
  { value: 'lastname', label: 'Last Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'address', label: 'Street Address' },
  { value: 'city', label: 'City' },
  { value: 'country', label: 'Country/Region' },
  { value: 'company', label: 'Company' },
  { value: 'jobtitle', label: 'Job Title' },
  { value: 'message', label: 'Message' },
];

const SYNC_DIRECTIONS = [
  { value: 'wix-to-hubspot', label: 'Wix → HubSpot' },
  { value: 'hubspot-to-wix', label: 'HubSpot → Wix' },
  { value: 'bidirectional', label: 'Bi-directional' },
];

const TRANSFORMS = [
  { value: 'none', label: 'None' },
  { value: 'trim', label: 'Trim whitespace' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'uppercase', label: 'Uppercase' },
];

// Simple dropdown component
const SimpleSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}> = ({ value, onChange, options, placeholder = 'Select...' }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    style={{
      width: '100%',
      padding: '8px 12px',
      borderRadius: '4px',
      border: '1px solid #ccc',
      fontSize: '14px',
      fontFamily: 'inherit',
      cursor: 'pointer',
    }}
  >
    <option value="">{placeholder}</option>
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);

export const FieldMappingTable: React.FC<FieldMappingTableProps> = ({
  onSave,
  initialMappings = [],
}) => {
  const [mappings, setMappings] = useState<FieldMapping[]>(initialMappings);
  const [newMapping, setNewMapping] = useState<Partial<FieldMapping>>({
    syncDirection: 'wix-to-hubspot',
    transform: 'none',
  });
  const [conflictRule, setConflictRule] = useState<'last-updated-wins' | 'source-priority'>('last-updated-wins');
  const [prioritySource, setPrioritySource] = useState<'hubspot' | 'wix'>('hubspot');
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    let ignore = false;

    const loadConfig = async () => {
      try {
        const response = await fetch(SYNC_CONFIG_URL);
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const config = data?.config;
        if (!config || ignore) {
          return;
        }

        if (Array.isArray(config.mappings) && config.mappings.length > 0) {
          setMappings(config.mappings);
        }

        if (config.conflictRule === 'source-priority' || config.conflictRule === 'last-updated-wins') {
          setConflictRule(config.conflictRule);
        }

        if (config.prioritySource === 'wix' || config.prioritySource === 'hubspot') {
          setPrioritySource(config.prioritySource);
        }
      } catch (error) {
        console.warn('Failed to load sync config:', error);
      }
    };

    loadConfig();
    return () => {
      ignore = true;
    };
  }, []);

  // Validation
  const validateMapping = (mapping: Partial<FieldMapping>): string[] => {
    const errs: string[] = [];

    if (!mapping.wixField) {
      errs.push('Wix field is required');
    }

    if (!mapping.hubspotProperty) {
      errs.push('HubSpot property is required');
    }

    // Check for duplicate HubSpot property mappings
    const isDuplicate = mappings.some(
      (m) =>
        m.hubspotProperty === mapping.hubspotProperty &&
        m.id !== mapping.id
    );
    if (isDuplicate) {
      errs.push('This HubSpot property is already mapped');
    }

    return errs;
  };

  const handleAddMapping = () => {
    const validationErrors = validateMapping(newMapping);

    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    const mapping: FieldMapping = {
      id: `mapping-${Date.now()}`,
      wixField: newMapping.wixField || '',
      hubspotProperty: newMapping.hubspotProperty || '',
      syncDirection: newMapping.syncDirection || 'wix-to-hubspot',
      transform: newMapping.transform,
    };

    setMappings([...mappings, mapping]);
    setNewMapping({
      syncDirection: 'wix-to-hubspot',
      transform: 'none',
    });
    setErrors([]);
    setSuccessMessage('Mapping added successfully');
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleRemoveMapping = (id: string) => {
    setMappings(mappings.filter((m) => m.id !== id));
    setSuccessMessage('Mapping removed');
    setTimeout(() => setSuccessMessage(''), 2000);
  };

  const handleUpdateMapping = (id: string, field: string, value: any) => {
    setMappings(
      mappings.map((m) =>
        m.id === id ? { ...m, [field]: value } : m
      )
    );
  };

  const [backendWarning, setBackendWarning] = useState('');

  const handleSave = async () => {
    // Validate all mappings before saving
    const allErrors: string[] = [];
    mappings.forEach((mapping) => {
      const errs = validateMapping(mapping);
      allErrors.push(...errs);
    });

    if (allErrors.length > 0) {
      setErrors(allErrors);
      return;
    }

    const payload: SyncConfigPayload = {
      mappings,
      conflictRule,
      prioritySource,
    };

    // Save locally first — always succeeds
    onSave?.(payload);
    setErrors([]);
    setBackendWarning('');
    setSuccessMessage('Sync configuration saved!');
    setTimeout(() => setSuccessMessage(''), 3000);

    // Attempt backend persistence as best-effort
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(SYNC_CONFIG_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Backend unavailable' }));
        setBackendWarning(`Backend sync skipped: ${err.error || 'server error'}. Mappings saved locally.`);
      }
    } catch {
      setBackendWarning('Backend server not reachable. Mappings saved locally only — start the backend to persist remotely.');
    }
  };

  return (
    <Box padding="24px" gap="16px" direction="vertical">
      {/* Header */}
      <Box gap="8px" direction="vertical">
        <Text weight="bold">Field Mapping</Text>
        <Text size="small" opacity="50%">
          Map Wix form fields to HubSpot contact properties. Choose sync direction and optional transformations.
        </Text>
      </Box>

      {/* Error Messages */}
      {errors.length > 0 && (
        <Card stretchVertically>
          <Box
            padding="12px"
            gap="8px"
            direction="vertical"
            style={{ backgroundColor: '#FFF3E0', borderRadius: '4px' }}
          >
            <Text weight="bold" color="#E65100">
              ⚠️ Validation Errors
            </Text>
            {errors.map((error, idx) => (
              <Text key={idx} color="#E65100" size="small">
                • {error}
              </Text>
            ))}
          </Box>
        </Card>
      )}

      {/* Success Message */}
      {successMessage && (
        <Card stretchVertically>
          <Box
            padding="12px"
            gap="8px"
            direction="vertical"
            style={{ backgroundColor: '#E8F5E9', borderRadius: '4px' }}
          >
            <Text weight="bold" color="#2E7D32">
              ✓ {successMessage}
            </Text>
          </Box>
        </Card>
      )}

      {/* Backend Warning */}
      {backendWarning && (
        <Card stretchVertically>
          <Box
            padding="12px"
            gap="8px"
            direction="vertical"
            style={{ backgroundColor: '#FFF8E1', borderRadius: '4px' }}
          >
            <Text weight="bold" color="#F57F17">
              ⚠ Backend sync skipped
            </Text>
            <Text size="small" color="#F57F17">
              {backendWarning}
            </Text>
          </Box>
        </Card>
      )}

      {/* Add New Mapping */}
      <Card stretchVertically>
        <Box
          padding="16px"
          gap="12px"
          direction="vertical"
          style={{ backgroundColor: '#F5F5F5', borderRadius: '4px' }}
        >
          <Text weight="bold">Add New Mapping</Text>
          <Box gap="12px" direction="horizontal" style={{ flexWrap: 'wrap' }}>
            <Box style={{ flex: 1, minWidth: '180px' }}>
              <Text size="small" weight="bold">
                Wix Field
              </Text>
              <SimpleSelect
                options={WIX_FIELDS}
                value={newMapping.wixField || ''}
                onChange={(value) =>
                  setNewMapping({ ...newMapping, wixField: value })
                }
                placeholder="Select field"
              />
            </Box>

            <Box style={{ flex: 1, minWidth: '200px' }}>
              <Text size="small" weight="bold">
                HubSpot Property
              </Text>
              <SimpleSelect
                options={HUBSPOT_PROPERTIES}
                value={newMapping.hubspotProperty || ''}
                onChange={(value) =>
                  setNewMapping({ ...newMapping, hubspotProperty: value })
                }
                placeholder="Select property"
              />
            </Box>

            <Box style={{ flex: 1, minWidth: '180px' }}>
              <Text size="small" weight="bold">
                Sync Direction
              </Text>
              <SimpleSelect
                options={SYNC_DIRECTIONS}
                value={newMapping.syncDirection || 'wix-to-hubspot'}
                onChange={(value) =>
                  setNewMapping({
                    ...newMapping,
                    syncDirection: value as any,
                  })
                }
              />
            </Box>

            <Box style={{ flex: 1, minWidth: '150px' }}>
              <Text size="small" weight="bold">
                Transform
              </Text>
              <SimpleSelect
                options={TRANSFORMS}
                value={newMapping.transform || 'none'}
                onChange={(value) =>
                  setNewMapping({ ...newMapping, transform: value as any })
                }
              />
            </Box>

            <Box style={{ alignSelf: 'flex-end' }}>
              <Button onClick={handleAddMapping} priority="primary">
                + Add
              </Button>
            </Box>
          </Box>
        </Box>
      </Card>

      <Card stretchVertically>
        <Box padding="16px" gap="12px" direction="vertical">
          <Text weight="bold">Conflict Handling</Text>
          <Text size="small" opacity="50%">
            Choose how to resolve simultaneous updates between Wix and HubSpot.
          </Text>
          <Box gap="12px" direction="horizontal" style={{ flexWrap: 'wrap' }}>
            <Box style={{ flex: 1, minWidth: '220px' }}>
              <Text size="small" weight="bold">
                Rule
              </Text>
              <SimpleSelect
                value={conflictRule}
                onChange={(value) =>
                  setConflictRule(value as 'last-updated-wins' | 'source-priority')
                }
                options={[
                  { value: 'last-updated-wins', label: 'Last Updated Wins (timestamp-based)' },
                  { value: 'source-priority', label: 'Deterministic Priority Source' },
                ]}
              />
            </Box>

            <Box style={{ flex: 1, minWidth: '220px' }}>
              <Text size="small" weight="bold">
                Priority Source
              </Text>
              <SimpleSelect
                value={prioritySource}
                onChange={(value) => setPrioritySource(value as 'hubspot' | 'wix')}
                options={[
                  { value: 'hubspot', label: 'HubSpot wins' },
                  { value: 'wix', label: 'Wix wins' },
                ]}
              />
            </Box>
          </Box>
        </Box>
      </Card>

      {/* Mappings Table */}
      {mappings.length > 0 && (
        <Box gap="16px" direction="vertical">
          <Text weight="bold">Current Mappings ({mappings.length})</Text>
          <Box
            style={{
              overflowX: 'auto',
              border: '1px solid #e0e0e0',
              borderRadius: '4px',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #e0e0e0' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>
                    Wix Field
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>
                    HubSpot Property
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>
                    Sync Direction
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>
                    Transform
                  </th>
                  <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping) => (
                  <tr key={mapping.id} style={{ borderBottom: '1px solid #e0e0e0' }}>
                    <td style={{ padding: '12px' }}>
                      <SimpleSelect
                        options={WIX_FIELDS}
                        value={mapping.wixField}
                        onChange={(value) =>
                          handleUpdateMapping(mapping.id, 'wixField', value)
                        }
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <SimpleSelect
                        options={HUBSPOT_PROPERTIES}
                        value={mapping.hubspotProperty}
                        onChange={(value) =>
                          handleUpdateMapping(mapping.id, 'hubspotProperty', value)
                        }
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <SimpleSelect
                        options={SYNC_DIRECTIONS}
                        value={mapping.syncDirection}
                        onChange={(value) =>
                          handleUpdateMapping(mapping.id, 'syncDirection', value)
                        }
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <SimpleSelect
                        options={TRANSFORMS}
                        value={mapping.transform || 'none'}
                        onChange={(value) =>
                          handleUpdateMapping(mapping.id, 'transform', value)
                        }
                      />
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <Tooltip content="Remove mapping">
                        <IconButton
                          onClick={() => handleRemoveMapping(mapping.id)}
                        >
                          <Icons.Delete />
                        </IconButton>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        </Box>
      )}

      {mappings.length === 0 && (
        <Card stretchVertically>
          <Box
            padding="32px"
            direction="vertical"
            style={{ textAlign: 'center', gap: '12px' }}
          >
            <div style={{ fontSize: '48px', opacity: '30%' }}>📋</div>
            <Text weight="bold">No field mappings yet</Text>
            <Text size="small" opacity="50%">
              Add your first mapping above to get started
            </Text>
          </Box>
        </Card>
      )}

      {/* Save Button */}
      {mappings.length > 0 && (
        <Box gap="12px" direction="horizontal">
          <Button onClick={handleSave} priority="primary">
            💾 Save Mappings
          </Button>
          <Text size="small" opacity="50%">
            {mappings.length} mapping{mappings.length !== 1 ? 's' : ''} ready to save · {conflictRule === 'last-updated-wins' ? 'last updated wins' : `${prioritySource} wins`}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default FieldMappingTable;
