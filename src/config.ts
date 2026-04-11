// Environment configuration for Railway deployment
// For local development: uses localhost:3001
// For production: uses Railway-deployed URL from environment variable

const isDevelopment = import.meta.env.DEV;

export const API_BASE_URL = isDevelopment 
  ? 'http://localhost:3001'
  : (import.meta.env.VITE_API_URL || 'https://your-railway-domain.railway.app');

export const WIX_FORM_URL = 'https://devcentertesting.wixforms.com/f/7448433885764912741';

export const WEBHOOK_URL = `${API_BASE_URL}/webhook/form-submission`;
