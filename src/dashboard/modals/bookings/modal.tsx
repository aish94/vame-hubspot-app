import React, { type FC, useState, useEffect } from 'react';
import { dashboard } from '@wix/dashboard';
import {
  WixDesignSystemProvider,
  Text,
  Box,
  CustomModalLayout,
  Button,
  Skeleton,
} from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import { width, height, title } from './modal.json';

interface Form {
  id: string;
  name: string;
  submitButtonText?: string;
}

const Modal: FC = () => {
  const [isAuthed, setIsAuthed] = useState(false);
  const [forms, setForms] = useState<Form[]>([]);
  const [selectedFormId, setSelectedFormId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const response = await fetch('http://localhost:3001/auth/hubspot/status');
        const data = await response.json();
        if (data.connected) {
          setIsAuthed(true);
          fetchForms();
        }
      } catch (err) {
        console.error('Auth status check error:', err);
      }
    };

    const timer = setInterval(checkAuthStatus, 2000);
    return () => clearInterval(timer);
  }, []);

  const fetchForms = async () => {
    setLoading(true);
    try {
      const response = await fetch('http://localhost:3001/api/hubspot/forms');
      const data = await response.json();
      if (data.forms) {
        setForms(data.forms);
      }
    } catch (err) {
      setError('Failed to fetch HubSpot forms');
      console.error('Fetch forms error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = () => {
    const popup = window.open(
      'http://localhost:3001/auth/hubspot/start',
      'HubSpot Auth',
      'width=500,height=600'
    );

    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer);
        setTimeout(() => {
          setIsAuthed(true);
          fetchForms();
        }, 1000);
      }
    }, 500);
  };

  const handleSelectForm = (formId: string) => {
    setSelectedFormId(formId);
  };

  const handleEmbedForm = async () => {
    if (!selectedFormId) return;

    try {
      const response = await fetch(
        `http://localhost:3001/api/hubspot/forms/${selectedFormId}/embed`
      );
      const data = await response.json();
      if (data.embedCode) {
        console.log('Form embedded:', data.embedCode);
        dashboard.closeModal();
      }
    } catch (err) {
      setError('Failed to embed form');
      console.error('Embed form error:', err);
    }
  };

  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <CustomModalLayout
        width={width}
        maxHeight={height}
        primaryButtonText={isAuthed && selectedFormId ? 'Embed Form' : 'Connect HubSpot'}
        secondaryButtonText="Cancel"
        primaryButtonOnClick={isAuthed && selectedFormId ? handleEmbedForm : handleConnect}
        secondaryButtonOnClick={() => dashboard.closeModal()}
        title={title}
        subtitle="Connect and embed HubSpot forms"
        content={
          <Box direction="vertical" align="left" gap="20px" padding="20px">
            {!isAuthed ? (
              <Box direction="vertical" align="center" gap="10px">
                <Text>Click "Connect HubSpot" to authenticate with your HubSpot account</Text>
              </Box>
            ) : loading ? (
              <Skeleton />
            ) : error ? (
              <Text color="red">{error}</Text>
            ) : forms.length === 0 ? (
              <Text>No forms found in your HubSpot account</Text>
            ) : (
              <Box direction="vertical" gap="12px">
                <Text tagName="h3">Select a form to embed:</Text>
                {forms.map((form) => (
                  <Box
                    key={form.id}
                    padding="12px"
                    border="1px solid #ccc"
                    borderRadius="4px"
                    onClick={() => handleSelectForm(form.id)}
                    style={{
                      cursor: 'pointer',
                      backgroundColor: selectedFormId === form.id ? '#f0f0f0' : 'transparent',
                      borderColor: selectedFormId === form.id ? '#0066ff' : '#ccc',
                    }}
                  >
                    <Text>{form.name}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        }
      />
    </WixDesignSystemProvider>
  );
};

export default Modal;
