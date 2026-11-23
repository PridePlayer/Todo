import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/base.css';
import { App } from './app';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在，index.html 被改坏了');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
