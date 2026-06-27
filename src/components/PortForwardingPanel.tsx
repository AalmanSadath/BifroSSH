import React, { useState, useRef, useEffect, useId } from 'react';
import { useAppStore } from '../store/appStore';
import type { PortForwarding } from '../types';

type PfType = 'local' | 'remote' | 'dynamic';

type WizStep =
  | 'type'
  | 'local-port' | 'local-host' | 'local-dest'
  | 'remote-host' | 'remote-port' | 'remote-dest'
  | 'dyn-host' | 'dyn-port'
  | 'label';

interface WizDraft {
  type: PfType;
  localPort: string;
  bindAddress: string;
  intermediateHostId: string;
  intermediateHostName: string;
  remoteHostId: string;
  remoteHostName: string;
  remotePort: string;
  destAddress: string;
  destPort: string;
  label: string;
}

interface EditDraft {
  id: string | null;
  type: PfType;
  label: string;
  localPort: string;
  bindAddress: string;
  intermediateHostId: string;
  intermediateHostName: string;
  remoteHostId: string;
  remoteHostName: string;
  remotePort: string;
  destAddress: string;
  destPort: string;
}

const DEFAULT_WIZ: WizDraft = {
  type: 'local',
  localPort: '',
  bindAddress: '127.0.0.1',
  intermediateHostId: '',
  intermediateHostName: '',
  remoteHostId: '',
  remoteHostName: '',
  remotePort: '',
  destAddress: '127.0.0.1',
  destPort: '',
  label: '',
};

function pfToEditDraft(pf: PortForwarding, servers: { id: string; name: string }[]): EditDraft {
  const intermediateHost = servers.find((s) => s.id === pf.intermediate_host_id);
  const remoteHost = servers.find((s) => s.id === pf.remote_host_id);
  return {
    id: pf.id,
    type: pf.type,
    label: pf.label,
    localPort: pf.local_port?.toString() ?? '',
    bindAddress: pf.bind_address,
    intermediateHostId: pf.intermediate_host_id ?? '',
    intermediateHostName: intermediateHost?.name ?? '',
    remoteHostId: pf.remote_host_id ?? '',
    remoteHostName: remoteHost?.name ?? '',
    remotePort: pf.remote_port?.toString() ?? '',
    destAddress: pf.dest_address,
    destPort: pf.dest_port?.toString() ?? '',
  };
}

function typeLabel(type: PfType) {
  return type === 'local' ? 'Local' : type === 'remote' ? 'Remote' : 'Dynamic';
}

function typeInitial(type: PfType) {
  return type === 'local' ? 'L' : type === 'remote' ? 'R' : 'D';
}

function typeColor(type: PfType) {
  return type === 'local' ? 'var(--accent)' : type === 'remote' ? '#a371f7' : '#f78166';
}

// ── Diagram ────────────────────────────────────────────────────

function PfDiagram({ pfType, step }: { pfType: PfType; step: number }) {
  const diagId = useId();
  const G = '#3fb950';
  const DIM = 'var(--border)';
  const DIML = 'var(--text-dim)';
  const FW = '#cf4444';

  let leftC = DIML, bottomC = DIML, rightC = DIML;
  let lineB = DIM;

  if (pfType === 'local') {
    if (step >= 1) { leftC = G; }
    if (step >= 2) { bottomC = G; lineB = G; }
    if (step >= 3) { rightC = G; }
    if (step >= 4) { leftC = G; bottomC = G; rightC = G; lineB = G; }
  } else if (pfType === 'remote') {
    if (step >= 1) { bottomC = G; lineB = G; }
    if (step >= 2) { leftC = G; }
    if (step >= 3) { rightC = G; }
    if (step >= 4) { leftC = G; bottomC = G; rightC = G; lineB = G; }
  } else {
    if (step >= 1) { leftC = G; }
    if (step >= 2) { bottomC = G; lineB = G; }
    if (step >= 3) { leftC = G; bottomC = G; lineB = G; }
  }

  const Server = ({ color }: { color: string }) => (
    <>
      <rect x="10" y="12" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
      <rect x="10" y="25" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
      <rect x="10" y="38" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
      <circle cx="49" cy="16.5" r="2.5" fill={color} opacity="0.8"/>
    </>
  );

  // Visual bbox of paths in 512-space: x=110..402, y=120..390 (arch peak at ~y=120 via quadratic bezier)
  // scale=0.12 → rendered 35×32. tx=32-256*0.12≈1.3, ty=(h/2)-255*0.12
  const BifroLogo = ({ color, h = 60 }: { color: string; h?: number }) => {
    const s = 0.12;
    const tx = (32 - 256 * s).toFixed(1);
    const ty = (h / 2 - 255 * s).toFixed(1);
    return (
      <g transform={`translate(${tx}, ${ty}) scale(${s})`}>
        <path d="M 110 390 L 110 200" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"/>
        <path d="M 402 390 L 402 200" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"/>
        <path d="M 110 200 Q 256 40 402 200" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"/>
        <path d="M 174 254 L 254 296 L 174 338" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M 254 360 L 338 360" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"/>
      </g>
    );
  };

  const Firewall = () => {
    const clipId = `fw-clip${diagId.replace(/:/g, '')}`;
    // Layout: 64×60 box, 5px inner padding, bricks w=23 h=10
    // Even rows (0,2): 2 bricks at x=7,34 (stride=27, gap=4, 2px from clip edge)
    // Odd row  (1):   3 bricks offset left by half-stride(13) → x=-6,21,48 → clipPath clips to 5..59
    const brickW = 23, brickH = 10, stride = 27;
    const evenX = (col: number) => 7 + col * stride;
    const oddX  = (col: number) => -6 + col * stride;
    return (
      <>
        <defs>
          <clipPath id={clipId}>
            <rect x="5" y="5" width="54" height="50" rx="6"/>
          </clipPath>
        </defs>
        <rect x="0" y="0" width="64" height="60" rx="10" fill={FW} fillOpacity="0.145" stroke={FW} strokeWidth="1.5"/>
        <g clipPath={`url(#${clipId})`}>
          {/* Row 0 — 2 full bricks */}
          {[0,1].map((col) => (
            <rect key={`r0-${col}`} x={evenX(col)} y={10} width={brickW} height={brickH} rx="2" fill={FW} fillOpacity="0.25" stroke={FW} strokeWidth="0.8"/>
          ))}
          {/* Row 1 — 3 bricks staggered right: half | full | half (clipped) */}
          {[0,1,2].map((col) => (
            <rect key={`r1-${col}`} x={oddX(col)} y={25} width={brickW} height={brickH} rx="2" fill={FW} fillOpacity="0.25" stroke={FW} strokeWidth="0.8"/>
          ))}
          {/* Row 2 — 2 full bricks */}
          {[0,1].map((col) => (
            <rect key={`r2-${col}`} x={evenX(col)} y={40} width={brickW} height={brickH} rx="2" fill={FW} fillOpacity="0.25" stroke={FW} strokeWidth="0.8"/>
          ))}
        </g>
      </>
    );
  };

  const leftIsBifro = pfType === 'local' || pfType === 'dynamic';
  const bottomIsBifro = pfType === 'remote';

  return (
    <svg viewBox="0 0 280 170" className="pf-diagram">
      {/* Left node */}
      <g transform="translate(8, 24)">
        <rect width="64" height="60" rx="10" fill={leftC} fillOpacity="0.12" stroke={leftC} strokeWidth="1.5"/>
        {leftIsBifro ? <BifroLogo color={leftC} /> : <Server color={leftC} />}
      </g>

      {/* Line Left → Center (always red — hits firewall) */}
      <line x1="79" y1="54" x2="101" y2="54" stroke={FW} strokeWidth="1.8"/>

      {/* Center Firewall */}
      <g transform="translate(108, 24)">
        <Firewall />
      </g>

      {/* Right node */}
      <g transform="translate(208, 24)">
        <rect width="64" height="60" rx="10" fill={rightC} fillOpacity="0.12" stroke={rightC} strokeWidth="1.5"/>
        <Server color={rightC} />
      </g>

      {/* Lines Left/Right → Bottom (14px gap each end along vector) */}
      <line x1="59" y1="90" x2="109" y2="106" stroke={lineB} strokeWidth="1.8"/>
      <line x1="221" y1="90" x2="171" y2="106" stroke={lineB} strokeWidth="1.8"/>

      {/* Bottom node */}
      <g transform="translate(108, 110)">
        <rect width="64" height="56" rx="10" fill={bottomC} fillOpacity="0.12" stroke={bottomC} strokeWidth="1.5"/>
        {bottomIsBifro ? <BifroLogo color={bottomC} h={56} /> : <Server color={bottomC} />}
      </g>
    </svg>
  );
}

// ── Floating label field ───────────────────────────────────────

function FloatField({
  label, value, onChange, placeholder, type = 'text', required,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; required?: boolean;
}) {
  return (
    <div className="pf-float-field">
      <label className="pf-float-label">{label}{required ? ' *' : ''}</label>
      <input
        className="pf-float-input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? ''}
      />
    </div>
  );
}

// ── Host chip (selected server) ────────────────────────────────

function HostChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <div className="pf-host-chip">
      <div className="pf-float-field pf-host-chip-field">
        <label className="pf-float-label">Selected host</label>
        <div className="pf-host-chip-name">{name}</div>
      </div>
      <button className="pf-host-remove-btn" onClick={onRemove}>Remove Host</button>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

export default function PortForwardingPanel() {
  const { servers, portForwardings, savePortForwarding, deletePortForwarding } = useAppStore();

  const [activePfIds, setActivePfIds] = useState<Set<string>>(new Set());
  const [drawerMode, setDrawerMode] = useState<'none' | 'wizard' | 'edit'>('none');
  const [editHostPickerOpen, setEditHostPickerOpen] = useState(false);
  const [wizStep, setWizStep] = useState<WizStep>('type');
  const [wizDraft, setWizDraft] = useState<WizDraft>(DEFAULT_WIZ);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; pf: PortForwarding } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    function down(e: MouseEvent) {
      if (!ctxRef.current?.contains(e.target as Node)) setCtxMenu(null);
    }
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [ctxMenu]);

  function closeDrawer() {
    setDrawerMode('none');
    setWizStep('type');
    setWizDraft(DEFAULT_WIZ);
    setEditDraft(null);
    setEditHostPickerOpen(false);
  }

  function openWizard() {
    setWizDraft(DEFAULT_WIZ);
    setWizStep('type');
    setDrawerMode('wizard');
  }

  function skipWizard(type: PfType) {
    const labelDefault = type === 'local' ? 'Local Rule' : type === 'remote' ? 'Remote Rule' : 'Dynamic Rule';
    setEditDraft({
      id: null,
      type,
      label: labelDefault,
      localPort: '',
      bindAddress: '127.0.0.1',
      intermediateHostId: '',
      intermediateHostName: '',
      remoteHostId: '',
      remoteHostName: '',
      remotePort: '',
      destAddress: type === 'local' ? '127.0.0.1' : '',
      destPort: '',
    });
    setDrawerMode('edit');
  }

  function editExisting(pf: PortForwarding) {
    setEditDraft(pfToEditDraft(pf, servers));
    setDrawerMode('edit');
    setCtxMenu(null);
  }

  function wizNext() {
    const t = wizDraft.type;
    const steps: Record<string, WizStep> = {
      'type':        t === 'local' ? 'local-port' : t === 'remote' ? 'remote-host' : 'dyn-port',
      'local-port':  'local-host',
      'local-host':  'local-dest',
      'local-dest':  'label',
      'remote-host': 'remote-port',
      'remote-port': 'remote-dest',
      'remote-dest': 'label',
      'dyn-port':    'dyn-host',
      'dyn-host':    'label',
    };
    setWizStep(steps[wizStep] ?? 'label');
  }

  function wizBack() {
    const t = wizDraft.type;
    const prev: Record<string, WizStep> = {
      'local-port':  'type',
      'local-host':  'local-port',
      'local-dest':  'local-host',
      'label':       t === 'local' ? 'local-dest' : t === 'remote' ? 'remote-dest' : 'dyn-host',
      'remote-host': 'type',
      'remote-port': 'remote-host',
      'remote-dest': 'remote-port',
      'dyn-port':    'type',
      'dyn-host':    'dyn-port',
    };
    setWizStep(prev[wizStep] ?? 'type');
  }

  function finishWizard() {
    const d = wizDraft;
    const labelDefault = d.type === 'local' ? 'Local Rule' : d.type === 'remote' ? 'Remote Rule' : 'Dynamic Rule';
    savePortForwarding({
      label: d.label.trim() || labelDefault,
      type: d.type,
      bind_address: d.bindAddress || '127.0.0.1',
      local_port: d.type !== 'remote' ? (parseInt(d.localPort) || null) : null,
      intermediate_host_id: (d.type === 'local' || d.type === 'dynamic') ? (d.intermediateHostId || null) : null,
      remote_host_id: d.type === 'remote' ? (d.remoteHostId || null) : null,
      remote_port: d.type === 'remote' ? (parseInt(d.remotePort) || null) : null,
      dest_address: d.destAddress,
      dest_port: d.type !== 'dynamic' ? (parseInt(d.destPort) || null) : null,
    });
    closeDrawer();
  }

  function saveEdit() {
    if (!editDraft) return;
    savePortForwarding({
      id: editDraft.id ?? undefined,
      label: editDraft.label.trim() || typeLabel(editDraft.type) + ' Rule',
      type: editDraft.type,
      bind_address: editDraft.bindAddress || '127.0.0.1',
      local_port: editDraft.type !== 'remote' ? (parseInt(editDraft.localPort) || null) : null,
      intermediate_host_id: (editDraft.type === 'local' || editDraft.type === 'dynamic') ? (editDraft.intermediateHostId || null) : null,
      remote_host_id: editDraft.type === 'remote' ? (editDraft.remoteHostId || null) : null,
      remote_port: editDraft.type === 'remote' ? (parseInt(editDraft.remotePort) || null) : null,
      dest_address: editDraft.destAddress,
      dest_port: editDraft.type !== 'dynamic' ? (parseInt(editDraft.destPort) || null) : null,
    });
    closeDrawer();
  }

  function handleCardDoubleClick(pf: PortForwarding) {
    setActivePfIds((prev) => {
      const next = new Set(prev);
      if (next.has(pf.id)) next.delete(pf.id);
      else next.add(pf.id);
      return next;
    });
  }

  function handleConfirmDelete(id: string) {
    deletePortForwarding(id);
    setConfirmDeleteId(null);
    if (drawerMode === 'edit' && editDraft?.id === id) closeDrawer();
  }

  function wiz(d: Partial<WizDraft>) {
    setWizDraft((prev) => ({ ...prev, ...d }));
  }

  function ed(d: Partial<EditDraft>) {
    setEditDraft((prev) => prev ? { ...prev, ...d } : prev);
  }

  // ── Wizard host picker select ───────────────────────────────
  function pickWizardHost(server: { id: string; name: string }) {
    if (wizStep === 'local-host' || wizStep === 'dyn-host') {
      wiz({ intermediateHostId: server.id, intermediateHostName: server.name });
      wizNext();
    } else if (wizStep === 'remote-host') {
      wiz({ remoteHostId: server.id, remoteHostName: server.name });
      wizNext();
    }
  }

  // ── Wizard step rendering ──────────────────────────────────

  function renderWizardStep() {
    switch (wizStep) {
      case 'type': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the port forwarding type:</p>
          <div className="pf-type-switcher">
            {(['local', 'remote', 'dynamic'] as PfType[]).map((t) => (
              <button
                key={t}
                className={`pf-type-tab${wizDraft.type === t ? ' active' : ''}`}
                onClick={() => wiz({ type: t })}
              >
                {typeLabel(t)}
              </button>
            ))}
          </div>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType={wizDraft.type} step={0} />
          </div>
          <p className="pf-wiz-desc">
            {wizDraft.type === 'local' && 'Local forwarding lets you access a remote server\'s listening port as though it were local.'}
            {wizDraft.type === 'remote' && 'Remote forwarding opens a port on the remote machine and forwards connections to the local (current) host.'}
            {wizDraft.type === 'dynamic' && 'Dynamic forwarding creates a local SOCKS proxy that tunnels all traffic through the remote SSH server.'}
          </p>
          <button className="btn-primary" style={{ width: '100%', marginBottom: 10 }} onClick={wizNext}>Continue</button>
          <button className="pf-skip-btn" onClick={() => skipWizard(wizDraft.type)}>Skip wizard</button>
        </div>
      );

      case 'local-port': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Set the local port and binding address:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="local" step={1} />
          </div>
          <p className="pf-wiz-desc">This port will be open on the local (current) machine to forward traffic to the remote host.</p>
          <FloatField label="Local port number" required value={wizDraft.localPort} onChange={(v) => wiz({ localPort: v })} type="number" placeholder="e.g. 8080" />
          <FloatField label="Bind address" value={wizDraft.bindAddress} onChange={(v) => wiz({ bindAddress: v })} placeholder="127.0.0.1" />
          <button className="btn-primary" style={{ width: '100%' }} onClick={wizNext} disabled={!wizDraft.localPort}>Continue</button>
        </div>
      );

      case 'local-host': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the intermediate host:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="local" step={2} />
          </div>
          <p className="pf-wiz-desc">This device is used as an intermediate host to access the remote host.</p>
          {wizDraft.intermediateHostId ? (
            <>
              <HostChip
                name={wizDraft.intermediateHostName}
                onRemove={() => wiz({ intermediateHostId: '', intermediateHostName: '' })}
              />
              <button className="btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={wizNext}>Continue</button>
            </>
          ) : (
            <div className="pf-host-list">
              {servers.length === 0
                ? <p className="pf-host-empty">No hosts saved yet.</p>
                : servers.map((s) => (
                  <button key={s.id} className="pf-host-item" onClick={() => pickWizardHost(s)}>
                    <span className="pf-host-item-name">{s.name}</span>
                    <span className="pf-host-item-addr">{s.host}:{s.port}</span>
                  </button>
                ))
              }
            </div>
          )}
        </div>
      );

      case 'local-dest': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the destination host:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="local" step={3} />
          </div>
          <p className="pf-wiz-desc">IP address/hostname and the port number of the remote host where the intermediate host will direct the traffic.</p>
          <FloatField label="Destination address" required value={wizDraft.destAddress} onChange={(v) => wiz({ destAddress: v })} placeholder="127.0.0.1" />
          <FloatField label="Destination port number" required value={wizDraft.destPort} onChange={(v) => wiz({ destPort: v })} type="number" placeholder="e.g. 22" />
          <button className="btn-primary" style={{ width: '100%' }} onClick={wizNext} disabled={!wizDraft.destAddress || !wizDraft.destPort}>Continue</button>
        </div>
      );

      case 'remote-host': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the remote host:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="remote" step={1} />
          </div>
          <p className="pf-wiz-desc">Select a host where the port will be open. The traffic from this port will be forwarded to the destination host.</p>
          {wizDraft.remoteHostId ? (
            <>
              <HostChip
                name={wizDraft.remoteHostName}
                onRemove={() => wiz({ remoteHostId: '', remoteHostName: '' })}
              />
              <button className="btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={wizNext}>Continue</button>
            </>
          ) : (
            <div className="pf-host-list">
              {servers.length === 0
                ? <p className="pf-host-empty">No hosts saved yet.</p>
                : servers.map((s) => (
                  <button key={s.id} className="pf-host-item" onClick={() => pickWizardHost(s)}>
                    <span className="pf-host-item-name">{s.name}</span>
                    <span className="pf-host-item-addr">{s.host}:{s.port}</span>
                  </button>
                ))
              }
            </div>
          )}
        </div>
      );

      case 'remote-port': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Set the port and binding address:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="remote" step={2} />
          </div>
          <p className="pf-wiz-desc">We will forward traffic from specified port and interface address of the selected host.</p>
          <FloatField label="Remote port number" required value={wizDraft.remotePort} onChange={(v) => wiz({ remotePort: v })} type="number" placeholder="e.g. 8080" />
          <FloatField label="Bind address" value={wizDraft.bindAddress} onChange={(v) => wiz({ bindAddress: v })} placeholder="127.0.0.1" />
          <button className="btn-primary" style={{ width: '100%' }} onClick={wizNext} disabled={!wizDraft.remotePort}>Continue</button>
        </div>
      );

      case 'remote-dest': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the destination host:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="remote" step={3} />
          </div>
          <p className="pf-wiz-desc">The destination address and port where the traffic will be forwarded.</p>
          <FloatField label="Destination address" required value={wizDraft.destAddress} onChange={(v) => wiz({ destAddress: v })} placeholder="127.0.0.1" />
          <FloatField label="Destination port number" required value={wizDraft.destPort} onChange={(v) => wiz({ destPort: v })} type="number" placeholder="e.g. 22" />
          <button className="btn-primary" style={{ width: '100%' }} onClick={wizNext} disabled={!wizDraft.destAddress || !wizDraft.destPort}>Continue</button>
        </div>
      );

      case 'dyn-port': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Set the local port and binding address:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="dynamic" step={1} />
          </div>
          <p className="pf-wiz-desc">This port will be open on the local (current) device, and it will receive the traffic.</p>
          <FloatField label="Local port number" required value={wizDraft.localPort} onChange={(v) => wiz({ localPort: v })} type="number" placeholder="e.g. 1080" />
          <FloatField label="Bind address" value={wizDraft.bindAddress} onChange={(v) => wiz({ bindAddress: v })} placeholder="127.0.0.1" />
          <button className="btn-primary" style={{ width: '100%' }} onClick={wizNext} disabled={!wizDraft.localPort}>Continue</button>
        </div>
      );

      case 'dyn-host': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the intermediate host:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType="dynamic" step={2} />
          </div>
          <p className="pf-wiz-desc">The intermediate host will receive the traffic that will be forwarded to the local (current) host.</p>
          {wizDraft.intermediateHostId ? (
            <>
              <HostChip
                name={wizDraft.intermediateHostName}
                onRemove={() => wiz({ intermediateHostId: '', intermediateHostName: '' })}
              />
              <button className="btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={wizNext}>Continue</button>
            </>
          ) : (
            <div className="pf-host-list">
              {servers.length === 0
                ? <p className="pf-host-empty">No hosts saved yet.</p>
                : servers.map((s) => (
                  <button key={s.id} className="pf-host-item" onClick={() => pickWizardHost(s)}>
                    <span className="pf-host-item-name">{s.name}</span>
                    <span className="pf-host-item-addr">{s.host}:{s.port}</span>
                  </button>
                ))
              }
            </div>
          )}
        </div>
      );

      case 'label': return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">Select the label:</p>
          <div className="pf-wiz-diagram-wrap">
            <PfDiagram pfType={wizDraft.type} step={4} />
          </div>
          <FloatField label="Label" value={wizDraft.label} onChange={(v) => wiz({ label: v })} placeholder={`${typeLabel(wizDraft.type)} Rule`} />
          <button className="btn-primary" style={{ width: '100%' }} onClick={finishWizard}>Done</button>
        </div>
      );
    }
  }

  // ── Edit form rendering ────────────────────────────────────

  function renderEditForm() {
    if (!editDraft) return null;
    const t = editDraft.type;
    const hostFieldLabel = t === 'remote' ? 'Remote host' : 'Intermediate host';
    const selectedHostId = t !== 'remote' ? editDraft.intermediateHostId : editDraft.remoteHostId;
    const selectedHostName = t !== 'remote' ? editDraft.intermediateHostName : editDraft.remoteHostName;

    return (
      <div className="pf-edit-form">
        <div className="pf-edit-diagram-wrap">
          <PfDiagram pfType={t} step={4} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div className="pf-badge-lg" style={{ background: typeColor(t) + '30', color: typeColor(t), border: `1.5px solid ${typeColor(t)}` }}>
            {typeInitial(t)}
          </div>
          <div style={{ flex: 1 }}>
            <FloatField label="Label" value={editDraft.label} onChange={(v) => ed({ label: v })} placeholder={typeLabel(t) + ' Rule'} />
          </div>
        </div>

        {/* Local port (local and dynamic) */}
        {t !== 'remote' && (
          <FloatField
            label="Local port number"
            required
            value={editDraft.localPort}
            onChange={(v) => ed({ localPort: v })}
            type="number"
            placeholder="e.g. 8080"
          />
        )}

        {/* Remote port (remote only) */}
        {t === 'remote' && (
          <FloatField
            label="Remote port number"
            required
            value={editDraft.remotePort}
            onChange={(v) => ed({ remotePort: v })}
            type="number"
            placeholder="e.g. 8080"
          />
        )}

        <FloatField label="Bind address" value={editDraft.bindAddress} onChange={(v) => ed({ bindAddress: v })} placeholder="127.0.0.1" />

        {/* Host selector */}
        {selectedHostId && !editHostPickerOpen ? (
          <div className="pf-host-chip" style={{ marginBottom: 12 }}>
            <div className="pf-float-field pf-host-chip-field" style={{ flex: 1 }}>
              <label className="pf-float-label">{hostFieldLabel} *</label>
              <div className="pf-host-chip-name">{selectedHostName}</div>
            </div>
            <button className="pf-host-remove-btn" onClick={() => {
              if (t !== 'remote') ed({ intermediateHostId: '', intermediateHostName: '' });
              else ed({ remoteHostId: '', remoteHostName: '' });
            }}>Remove Host</button>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <label className="pf-float-label" style={{ display: 'block', marginBottom: 6 }}>{hostFieldLabel} *</label>
            <div className="pf-host-list pf-host-list-inline">
              {servers.length === 0
                ? <p className="pf-host-empty">No hosts saved yet.</p>
                : servers.map((s) => (
                  <button
                    key={s.id}
                    className={`pf-host-item${selectedHostId === s.id ? ' selected' : ''}`}
                    onClick={() => {
                      if (t !== 'remote') ed({ intermediateHostId: s.id, intermediateHostName: s.name });
                      else ed({ remoteHostId: s.id, remoteHostName: s.name });
                      setEditHostPickerOpen(false);
                    }}
                  >
                    <span className="pf-host-item-name">{s.name}</span>
                    <span className="pf-host-item-addr">{s.host}:{s.port}</span>
                  </button>
                ))
              }
            </div>
          </div>
        )}

        {/* Destination (local and remote only) */}
        {t !== 'dynamic' && (
          <>
            <FloatField label="Destination address" required value={editDraft.destAddress} onChange={(v) => ed({ destAddress: v })} placeholder="127.0.0.1" />
            <FloatField label="Destination port number" required value={editDraft.destPort} onChange={(v) => ed({ destPort: v })} type="number" placeholder="e.g. 22" />
          </>
        )}
      </div>
    );
  }

  // ── Card description ────────────────────────────────────────

  function pfCardDesc(pf: PortForwarding): React.ReactNode {
    const host = servers.find((s) => s.id === (pf.intermediate_host_id ?? pf.remote_host_id));
    const Arr = () => (
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, margin: '0 3px' }}>
        <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
      </svg>
    );
    if (pf.type === 'local') {
      return <>{`localhost:${pf.local_port ?? '?'}`}<Arr/>{host?.name ?? '?'}<Arr/>{`${pf.dest_address}:${pf.dest_port ?? '?'}`}</>;
    }
    if (pf.type === 'remote') {
      return <>{`${host?.name ?? '?'}:${pf.remote_port ?? '?'}`}<Arr/>{`${pf.dest_address}:${pf.dest_port ?? '?'}`}</>;
    }
    return `SOCKS5 localhost:${pf.local_port ?? '?'} via ${host?.name ?? '?'}`;
  }

  return (
    <>
      <div
        className="panel pf-panel"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="panel-title-row">
          <div className="panel-title">Port Forwarding</div>
          <button className="btn-primary btn-sm" onClick={openWizard}>+ New</button>
        </div>

        {portForwardings.length === 0 ? (
          <div className="pf-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              <path d="M15 5l4 4"/>
            </svg>
            <p>No port forwarding rules yet.</p>
            <button className="btn-primary" onClick={openWizard}>Create your first rule</button>
          </div>
        ) : (
          <div className="pf-grid">
            {portForwardings.map((pf) => {
              const active = activePfIds.has(pf.id);
              return (
                <div
                  key={pf.id}
                  className={`pf-card${active ? ' pf-card-active' : ''}`}
                  onDoubleClick={() => handleCardDoubleClick(pf)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, pf }); }}
                  title="Double-click to activate · Right-click for options"
                >
                  <div className="pf-card-left">
                    <div
                      className="pf-badge"
                      style={{ background: typeColor(pf.type) + '25', color: typeColor(pf.type), border: `1.5px solid ${typeColor(pf.type)}` }}
                    >
                      {typeInitial(pf.type)}
                    </div>
                  </div>
                  <div className="pf-card-body">
                    <div className="pf-card-header">
                      <span className="pf-card-label">{pf.label}</span>
                      {active && <span className="pf-card-active-dot" />}
                    </div>
                    <span className="pf-card-desc">{pfCardDesc(pf)}</span>
                  </div>
                  <button
                    className="pf-card-edit-btn"
                    onClick={(e) => { e.stopPropagation(); editExisting(pf); }}
                    title="Edit"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Wizard / Edit Drawer */}
      {drawerMode !== 'none' && (
        <>
          <div className="drawer-backdrop" onClick={closeDrawer} />
          <div className="drawer pf-drawer" onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            <div className="drawer-header">
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {drawerMode === 'wizard'
                    ? (wizStep === 'type' ? 'New Port Forwarding' : typeLabel(wizDraft.type) + ' Port Forwarding')
                    : (editDraft?.id ? 'Edit Port Forwarding' : 'New Port Forwarding')}
                </div>
              </div>
              <button className="drawer-close" onClick={closeDrawer}>✕</button>
            </div>

            <div className="pf-drawer-body">
              {drawerMode === 'wizard' && (
                <>
                  {wizStep !== 'type' && (
                    <button className="pf-back-btn" onClick={wizBack}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15,18 9,12 15,6"/>
                      </svg>
                      Back
                    </button>
                  )}
                  {renderWizardStep()}
                </>
              )}

              {drawerMode === 'edit' && (
                <>
                  {renderEditForm()}
                  <div className="pf-edit-actions">
                    {editDraft?.id && (
                      <button className="btn-danger btn-sm" onClick={() => setConfirmDeleteId(editDraft.id!)}>Delete</button>
                    )}
                    <button className="btn-secondary btn-sm" onClick={closeDrawer}>Cancel</button>
                    <button className="btn-primary btn-sm" onClick={saveEdit}>Save</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="host-context-menu"
          style={{
            top: Math.min(ctxMenu.y, window.innerHeight - 120),
            left: Math.min(ctxMenu.x, window.innerWidth - 160),
          }}
        >
          <button className="host-ctx-item" onClick={() => { handleCardDoubleClick(ctxMenu.pf); setCtxMenu(null); }}>
            {activePfIds.has(ctxMenu.pf.id) ? 'Deactivate' : 'Activate'}
          </button>
          <button className="host-ctx-item" onClick={() => editExisting(ctxMenu.pf)}>
            Edit
          </button>
          <div className="host-ctx-divider" />
          <button className="host-ctx-item host-ctx-danger" onClick={() => { setConfirmDeleteId(ctxMenu.pf.id); setCtxMenu(null); }}>
            Delete
          </button>
        </div>
      )}

      {/* Confirm delete */}
      {confirmDeleteId && (
        <>
          <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)} />
          <div className="kc-confirm-modal">
            <p>Delete this port forwarding rule?</p>
            <div className="kc-confirm-actions">
              <button className="btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="btn-danger btn-sm" onClick={() => handleConfirmDelete(confirmDeleteId)}>Delete</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
