import './history';
import './projectRuntime';
import './webMcpConnection';
import './webMcpCoreTools';
import './webMcpProjectTools';
import './webMcpAppTools';
import './statKeySync';
import './statSearchSelect';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './mobile.css';
import './shortcutLegend.css';
import './nodeLabels.css';
import './iconPool.css';
import './playtest.css';
import './perks.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
