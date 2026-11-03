import { useState } from 'react';
import ExportDataModal from '../ExportDataModal';
import ImportDataModal from '../ImportDataModal';

/** The whole document out to a file, and back in from one. */
export default function DataSection() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <section className="panel-section">
      <h3>Backup and transfer</h3>
      <p className="form-hint form-hint-flush">One file, encrypted with its own passphrase. Import only adds.</p>
      <div className="transfer-buttons">
        <button className="btn-secondary" onClick={() => setExporting(true)}>Export…</button>
        <button className="btn-secondary" onClick={() => setImporting(true)}>Import…</button>
      </div>

      {exporting && <ExportDataModal onClose={() => setExporting(false)} />}
      {importing && <ImportDataModal onClose={() => setImporting(false)} />}
    </section>
  );
}
