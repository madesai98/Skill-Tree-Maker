import './history';
import './projectRuntime';
import './webMcpBootstrap';
import './webMcp';
import './webMcpEnvironmentSetup';
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
