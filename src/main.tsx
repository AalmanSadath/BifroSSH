import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

document.addEventListener('contextmenu', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
