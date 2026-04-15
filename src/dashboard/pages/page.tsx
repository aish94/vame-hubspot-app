import React, { type FC, useState, useEffect } from 'react';
import { dashboard } from '@wix/dashboard';
import {
  Button,
  Page,
  WixDesignSystemProvider,
  Tabs,
  Box,
  Text,
} from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import * as Icons from '@wix/wix-ui-icons-common';
import FieldMappingTable from '../components/FieldMappingTable';
import { STATUS_URL, CONNECT_URL, DISCONNECT_URL } from '../../config';

interface FieldMapping {
  id: string;
  wixField: string;
  hubspotProperty: string;
  syncDirection: 'wix-to-hubspot' | 'hubspot-to-wix' | 'bidirectional';
  transform?: 'trim' | 'lowercase' | 'uppercase' | 'none';
}

interface SyncConfigPayload {
  mappings: FieldMapping[];
  conflictRule: 'last-updated-wins' | 'source-priority';
  prioritySource: 'hubspot' | 'wix';
}

interface ConnectionStatus {
  connected: boolean;
  connectedAt?: number;
  tokenExpired?: boolean;
}

const Index: FC = () => {
  const [activeTab, setActiveTab] = useState('field-mapping');
  const [savedMappings, setSavedMappings] = useState<FieldMapping[]>([]);
  const [conflictRule, setConflictRule] = useState<'last-updated-wins' | 'source-priority'>('last-updated-wins');
  const [prioritySource, setPrioritySource] = useState<'hubspot' | 'wix'>('hubspot');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    fetch(STATUS_URL)
      .then((r) => r.json())
      .then((data) => setConnectionStatus(data))
      .catch(() => setConnectionStatus({ connected: false }));
  }, []);

  const handleConnect = () => {
    window.open(CONNECT_URL, '_blank', 'noopener,noreferrer');
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect from HubSpot? Sync will stop until you reconnect.')) return;
    setDisconnecting(true);
    try {
      await fetch(DISCONNECT_URL, { method: 'POST' });
      setConnectionStatus({ connected: false });
    } catch {
      alert('Failed to disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSaveMappings = (payload: SyncConfigPayload) => {
    setSavedMappings(payload.mappings);
    setConflictRule(payload.conflictRule);
    setPrioritySource(payload.prioritySource);
  };

  const isConnected = connectionStatus?.connected && !connectionStatus?.tokenExpired;

  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <Page>
        <Page.Header
          title="HubSpot Integration"
          subtitle="Manage field mappings and HubSpot connection settings."
          actionsBar={
            <Box gap="12px" direction="horizontal" verticalAlign="middle">
              {connectionStatus !== null && (
                <Text size="small" weight="normal">
                  {isConnected ? '🟢 Connected to HubSpot' : '🔴 Not connected'}
                </Text>
              )}
              {isConnected ? (
                <Button
                  priority="secondary"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              ) : (
                <Button onClick={handleConnect} prefixIcon={<Icons.GetStarted />}>
                  Connect HubSpot
                </Button>
              )}
              <Button
                priority="secondary"
                onClick={() => dashboard.openModal('b6a34a8c-1474-4b80-86bb-398e380589cb')}
              >
                Contact Form
              </Button>
            </Box>
          }
        />
        <Page.Content>
          <Tabs
            activeId={activeTab}
            onClick={(tab) => setActiveTab(tab.id as string)}
            items={[
              { id: 'field-mapping', title: 'Field Mapping' },
              { id: 'settings',      title: 'Settings' },
            ]}
          />
          <Box padding="24px">
            {activeTab === 'field-mapping' && (
              <FieldMappingTable
                initialMappings={savedMappings}
                onSave={handleSaveMappings}
              />
            )}
            {activeTab === 'settings' && (
              <div>
                <h3>Sync Settings</h3>
                <p>Conflict rule: {conflictRule}</p>
                <p>Priority source: {prioritySource}</p>
              </div>
            )}
          </Box>
        </Page.Content>
      </Page>
    </WixDesignSystemProvider>
  );
};

export default Index;


