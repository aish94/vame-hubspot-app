import React, { type FC, useState } from 'react';
import { dashboard } from '@wix/dashboard';
import {
  WixDesignSystemProvider,
  Box,
  CustomModalLayout,
  Text,
  Input,
} from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import { width, height, title } from './modal.json';
import { WEBHOOK_URL } from '../../../config';

interface ContactForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  message: string;
}

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

/** Reads UTM params from URL + sessionStorage (persists across page navigations). */
const captureAttribution = () => {
  if (typeof window === 'undefined') {
    return { utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: '', source_url: '', referrer: '', submitted_at: new Date().toISOString() };
  }
  const p = new URLSearchParams(window.location.search);
  const g = (key: string) => p.get(key) || sessionStorage.getItem(key) || '';
  // Persist UTM params so they survive sub-page navigations
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((k) => {
    if (p.get(k)) sessionStorage.setItem(k, p.get(k)!);
  });
  return {
    utm_source:   g('utm_source'),
    utm_medium:   g('utm_medium'),
    utm_campaign: g('utm_campaign'),
    utm_term:     g('utm_term'),
    utm_content:  g('utm_content'),
    source_url:   window.location.href,
    referrer:     document.referrer || '',
    submitted_at: new Date().toISOString(),
  };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Modal: FC = () => {
  const [form, setForm] = useState<ContactForm>({
    firstName: '', lastName: '', email: '', phone: '', company: '', message: '',
  });
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const set = (field: keyof ContactForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.email.trim()) {
      setErrorMessage('Email address is required.');
      return;
    }
    if (!EMAIL_RE.test(form.email.trim())) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setStatus('submitting');
    setErrorMessage('');

    const attribution = captureAttribution();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstname: form.firstName.trim(),
          lastname:  form.lastName.trim(),
          email:     form.email.trim().toLowerCase(),
          phone:     form.phone.trim(),
          company:   form.company.trim(),
          message:   form.message.trim(),
          attribution,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.success !== false) {
        setStatus('success');
      } else {
        setStatus('error');
        setErrorMessage((result as any).error || 'Submission failed. Please try again.');
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      setStatus('error');
      setErrorMessage(
        err?.name === 'AbortError'
          ? 'Request timed out. Please check your connection and try again.'
          : 'Could not reach the server. Please try again later.',
      );
    }
  };

  const isSubmitting = status === 'submitting';
  const isSuccess    = status === 'success';

  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <CustomModalLayout
        width={width}
        maxHeight={height}
        title={title}
        subtitle={isSuccess ? 'Thank you!' : "Fill in your details and we'll be in touch."}
        primaryButtonText={isSuccess ? 'Close' : isSubmitting ? 'Sending…' : 'Submit'}
        primaryButtonOnClick={isSuccess ? () => dashboard.closeModal() : handleSubmit}
        secondaryButtonText={isSuccess ? undefined : 'Cancel'}
        secondaryButtonOnClick={() => dashboard.closeModal()}
        content={
          isSuccess ? (
            <Box padding="24px" direction="vertical" gap="16px" align="center">
              <div style={{ fontSize: '48px', textAlign: 'center' }}>✅</div>
              <Text weight="bold">Message sent successfully!</Text>
              <Text size="small">Your details have been received. We'll be in touch soon.</Text>
            </Box>
          ) : (
            <Box direction="vertical" gap="16px" padding="8px 0">
              {status === 'error' && errorMessage && (
                <Box
                  padding="12px"
                  style={{
                    backgroundColor: '#FFF3E0',
                    borderRadius: '4px',
                    border: '1px solid #FFB74D',
                  }}
                >
                  <Text size="small">⚠ {errorMessage}</Text>
                </Box>
              )}

              {/* Name row */}
              <Box gap="12px" direction="horizontal">
                <Box direction="vertical" gap="4px" style={{ flex: 1 }}>
                  <Text size="small" weight="bold">First Name</Text>
                  <Input value={form.firstName} onChange={set('firstName')} placeholder="First name" disabled={isSubmitting} />
                </Box>
                <Box direction="vertical" gap="4px" style={{ flex: 1 }}>
                  <Text size="small" weight="bold">Last Name</Text>
                  <Input value={form.lastName} onChange={set('lastName')} placeholder="Last name" disabled={isSubmitting} />
                </Box>
              </Box>

              <Box direction="vertical" gap="4px">
                <Text size="small" weight="bold">Email *</Text>
                <Input value={form.email} onChange={set('email')} placeholder="your@email.com" type="email" disabled={isSubmitting} />
              </Box>

              <Box direction="vertical" gap="4px">
                <Text size="small" weight="bold">Phone</Text>
                <Input value={form.phone} onChange={set('phone')} placeholder="+1 (555) 000-0000" disabled={isSubmitting} />
              </Box>

              <Box direction="vertical" gap="4px">
                <Text size="small" weight="bold">Company</Text>
                <Input value={form.company} onChange={set('company')} placeholder="Company name" disabled={isSubmitting} />
              </Box>

              <Box direction="vertical" gap="4px">
                <Text size="small" weight="bold">Message</Text>
                <textarea
                  value={form.message}
                  onChange={set('message')}
                  placeholder="How can we help you?"
                  rows={4}
                  disabled={isSubmitting}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #dfe3eb',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
              </Box>

              <Text size="tiny">
                * Required. Your data is processed according to our privacy policy.
              </Text>
            </Box>
          )
        }
      />
    </WixDesignSystemProvider>
  );
};

export default Modal;
