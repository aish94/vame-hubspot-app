import React, { type FC, useEffect } from 'react';
import { dashboard } from '@wix/dashboard';
import {
  WixDesignSystemProvider,
  Box,
  CustomModalLayout,
} from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import { width, height, title } from './modal.json';
import { WIX_FORM_URL, WEBHOOK_URL } from '../../../config';

const Modal: FC = () => {
  useEffect(() => {
    const submitFormToHubSpot = async (formData: any) => {
      try {
        console.log('Sending form data to HubSpot:', formData);

        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });

        const result = await response.json();

        if (result.success) {
          console.log('✅ Contact created in HubSpot successfully');
          console.log('Contact ID:', result.contactId);
        } else {
          console.error('❌ Failed to create contact:', result.error);
        }
      } catch (error) {
        console.error('❌ Error sending form data to HubSpot:', error);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      const messageData = event.data;

      console.log('Message received:', messageData);

      if (typeof messageData === 'object' && messageData !== null) {
        if (
          messageData.type === 'form-submitted' ||
          messageData.event === 'form-submitted' ||
          messageData.status === 'success' ||
          messageData.success === true ||
          messageData.formSubmitted === true
        ) {
          console.log('Form submission detected');
          const formToSubmit = messageData.payload || messageData.data || messageData;
          submitFormToHubSpot(formToSubmit);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    const monitorIframe = () => {
      const iframeElement = document.querySelector('iframe[title="Wix Form"]') as HTMLIFrameElement;

      if (iframeElement && iframeElement.contentWindow) {
        iframeElement.contentWindow.addEventListener('message', handleMessage);
      }
    };

    const timeout = setTimeout(monitorIframe, 1000);

    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
    };
  }, []);



  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <CustomModalLayout
        width={width}
        maxHeight={height}
        primaryButtonText="Close"
        secondaryButtonText={undefined}
        primaryButtonOnClick={() => dashboard.closeModal()}
        title={title}
        subtitle="Contact us"
        content={
          <Box direction="vertical" align="center" gap="20px" padding="0">
            <iframe
              src={WIX_FORM_URL}
              title="Wix Form"
              style={{
                width: '100%',
                height: '600px',
                border: 'none',
                borderRadius: '4px',
              }}
            />
          </Box>
        }
      />
    </WixDesignSystemProvider>
  );
};

export default Modal;
