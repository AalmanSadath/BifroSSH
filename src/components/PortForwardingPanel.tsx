import React, { useState, useId } from 'react';
import { useAppStore } from '../store/appStore';
import type { PortForwarding } from '../types';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import Drawer from './shared/Drawer';
import { cardKeys } from './shared/cardKeys';
import { EditIcon } from './shared/icons';

type PfType = 'local' | 'remote' | 'dynamic';

type WizStep =
  | 'type'
  | 'local-port' | 'local-host' | 'local-dest'
  | 'remote-host' | 'remote-port' | 'remote-dest'
  | 'dyn-host' | 'dyn-port'
  | 'label';

/**
 * One rule being written, whether by the wizard or the edit form.
 *
 * These were two interfaces with the same twelve fields, differing only in
 * that the edit form carries the id of the rule it is changing. The wizard
 * leaves that null.
 */
interface Draft {
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

/** The default label for a rule the user did not name. */
function defaultLabel(type: PfType) {
  return `${typeLabel(type)} Rule`;
}

/**
 * A draft as the backend wants it.
 *
 * The wizard and the edit form both ended here and each wrote out the same
 * nine fields, which had already drifted: the default label was spelled three
 * different ways across the file. Which fields apply depends on the type, and
 * that decision now exists once.
 */
function draftToPf(d: Draft) {
  const local = d.type === 'local';
  const dynamic = d.type === 'dynamic';
  const remote = d.type === 'remote';
  return {
    id: d.id ?? undefined,
    label: d.label.trim() || defaultLabel(d.type),
    type: d.type,
    bind_address: d.bindAddress || '127.0.0.1',
    local_port: !remote ? (parseInt(d.localPort) || null) : null,
    intermediate_host_id: (local || dynamic) ? (d.intermediateHostId || null) : null,
    remote_host_id: remote ? (d.remoteHostId || null) : null,
    remote_port: remote ? (parseInt(d.remotePort) || null) : null,
    dest_address: d.destAddress,
    dest_port: !dynamic ? (parseInt(d.destPort) || null) : null,
  };
}

/**
 * The steps each kind of rule walks through, in order.
 *
 * wizNext and wizBack were two hand-written maps that had to be kept mutual
 * inverses by hand, and adding a rule type meant editing four branch
 * expressions across them. One list per type, and the two directions are an
 * index either side.
 */
/** A text box in a `fields` step. */
interface WizField {
  key: 'localPort' | 'remotePort' | 'bindAddress' | 'destAddress' | 'destPort';
  label: string;
  required?: boolean;
  numeric?: boolean;
  placeholder: string;
}

type WizSpec =
  | { kind: 'type'; title: string; diagram: number }
  | { kind: 'fields'; title: string; desc: string; diagram: number; fields: WizField[] }
  | { kind: 'host'; title: string; desc: string; diagram: number; host: 'intermediate' | 'remote'; field: string }
  | { kind: 'label'; title: string; diagram: number };

const TYPE_DESC: Record<PfType, string> = {
  local: "Local forwarding lets you access a remote server's listening port as though it were local.",
  remote: 'Remote forwarding opens a port on the remote machine and forwards connections to the local (current) host.',
  dynamic: 'Dynamic forwarding creates a local SOCKS proxy that tunnels all traffic through the remote SSH server.',
};

/** The diagram and its wrapper, which every step draws the same way. */
function WizDiagram({ type, step }: { type: PfType; step: number }) {
  return (
    <div className="pf-wiz-diagram-wrap">
      <PfDiagram pfType={type} step={step} />
    </div>
  );
}

const BIND_FIELD: WizField = { key: 'bindAddress', label: 'Bind address', placeholder: '127.0.0.1' };

const DEST_FIELDS: WizField[] = [
  { key: 'destAddress', label: 'Destination address', required: true, placeholder: '127.0.0.1' },
  { key: 'destPort', label: 'Destination port number', required: true, numeric: true, placeholder: 'e.g. 22' },
];

/**
 * What each step of the wizard shows.
 *
 * This was a ten-case switch of 168 lines, and only five of the ten were
 * distinct: the three port steps differ in one draft key and their wording,
 * the three host steps in which host they pick, and the two destination steps
 * in nothing but their title and description. Anything genuinely per-step is
 * a value here; the shapes are rendered once each.
 */
const WIZ: Record<WizStep, WizSpec> = {
  'type': { kind: 'type', title: 'Select the port forwarding type:', diagram: 0 },

  'local-port': {
    kind: 'fields', diagram: 1,
    title: 'Set the local port and binding address:',
    desc: 'This port will be open on the local (current) machine to forward traffic to the remote host.',
    fields: [{ key: 'localPort', label: 'Local port number', required: true, numeric: true, placeholder: 'e.g. 8080' }, BIND_FIELD],
  },
  'local-host': {
    kind: 'host', diagram: 2, host: 'intermediate', field: 'Intermediate host',
    title: 'Select the intermediate host:',
    desc: 'This device is used as an intermediate host to access the remote host.',
  },
  'local-dest': {
    kind: 'fields', diagram: 3, fields: DEST_FIELDS,
    title: 'Select the destination host:',
    desc: 'IP address/hostname and the port number of the remote host where the intermediate host will direct the traffic.',
  },

  'remote-host': {
    kind: 'host', diagram: 1, host: 'remote', field: 'Remote host',
    title: 'Select the remote host:',
    desc: 'Select a host where the port will be open. The traffic from this port will be forwarded to the destination host.',
  },
  'remote-port': {
    kind: 'fields', diagram: 2,
    title: 'Set the port and binding address:',
    desc: 'We will forward traffic from specified port and interface address of the selected host.',
    fields: [{ key: 'remotePort', label: 'Remote port number', required: true, numeric: true, placeholder: 'e.g. 8080' }, BIND_FIELD],
  },
  'remote-dest': {
    kind: 'fields', diagram: 3, fields: DEST_FIELDS,
    title: 'Select the destination host:',
    desc: 'The destination address and port where the traffic will be forwarded.',
  },

  'dyn-port': {
    kind: 'fields', diagram: 1,
    title: 'Set the local port and binding address:',
    desc: 'This port will be open on the local (current) device, and it will receive the traffic.',
    fields: [{ key: 'localPort', label: 'Local port number', required: true, numeric: true, placeholder: 'e.g. 1080' }, BIND_FIELD],
  },
  'dyn-host': {
    kind: 'host', diagram: 2, host: 'intermediate', field: 'Intermediate host',
    title: 'Select the intermediate host:',
    desc: 'The intermediate host will receive the traffic that will be forwarded to the local (current) host.',
  },

  'label': { kind: 'label', title: 'Select the label:', diagram: 4 },
};

const STEPS: Record<PfType, WizStep[]> = {
  local:   ['type', 'local-port', 'local-host', 'local-dest', 'label'],
  remote:  ['type', 'remote-host', 'remote-port', 'remote-dest', 'label'],
  dynamic: ['type', 'dyn-port', 'dyn-host', 'label'],
};

const DEFAULT_WIZ: Draft = {
  id: null,
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

function pfToDraft(pf: PortForwarding, servers: { id: string; name: string }[]): Draft {
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


// The diagram's own palette. G follows the theme; the firewall red is part of
// an illustration rather than a status, so it is the same in every theme, like
// the traffic lights in the theme preview.
const DIAG_OK = 'var(--success)';
const DIAG_DIM_LINE = 'var(--border)';
const DIAG_DIM = 'var(--text-dim)';
const FW = '#cf4444';

/** The little arrow between hops in a rule's one-line description. */
function Arr() {
  return (
    <svg className="pf-desc-arrow" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}

function Server({ color }: { color: string }) {
  return (
    <>
    <rect x="10" y="12" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
    <rect x="10" y="25" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
    <rect x="10" y="38" width="44" height="9" rx="2.5" fill="none" stroke={color} strokeWidth="1.4"/>
      <circle cx="49" cy="16.5" r="2.5" fill={color} opacity="0.8"/>
    </>
  );
}

// Visual bbox of paths in 512-space: x=110..402, y=120..390 (arch peak at ~y=120 via quadratic bezier)
// scale=0.12 → rendered 35×32. tx=32-256*0.12≈1.3, ty=(h/2)-255*0.12
function BifroLogo({ color, h = 60 }: { color: string; h?: number }) {
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
}

function Firewall({ clipId }: { clipId: string }) {
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
}

function PfDiagram({ pfType, step }: { pfType: PfType; step: number }) {
  const diagId = useId();
  const clipId = `fw-clip${diagId.replace(/:/g, '')}`;
  const G = DIAG_OK;
  const DIM = DIAG_DIM_LINE;
  const DIML = DIAG_DIM;

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
        <Firewall clipId={clipId} />
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
  const { servers, portForwardings, savePortForwarding, deletePortForwarding, activeTunnelIds, startTunnel, stopTunnel } = useAppStore();
  const [drawerMode, setDrawerMode] = useState<'none' | 'wizard' | 'edit'>('none');
  const [wizStep, setWizStep] = useState<WizStep>('type');
  const [wizDraft, setWizDraft] = useState<Draft>(DEFAULT_WIZ);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [hostPickerTarget, setHostPickerTarget] = useState<'intermediate' | 'remote'>('intermediate');
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; pf: PortForwarding } | null>(null);
  const [panelCtx, setPanelCtx] = useState<{ x: number; y: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function closeDrawer() {
    setDrawerMode('none');
    setWizStep('type');
    setWizDraft(DEFAULT_WIZ);
    setEditDraft(null);
    setHostPickerOpen(false);
  }

  function openHostPicker(target: 'intermediate' | 'remote') {
    setHostPickerTarget(target);
    setHostPickerOpen(true);
  }

  function selectPickerHost(s: { id: string; name: string }) {
    if (drawerMode === 'wizard') {
      if (hostPickerTarget === 'intermediate') wiz({ intermediateHostId: s.id, intermediateHostName: s.name });
      else wiz({ remoteHostId: s.id, remoteHostName: s.name });
    } else {
      if (hostPickerTarget === 'intermediate') ed({ intermediateHostId: s.id, intermediateHostName: s.name });
      else ed({ remoteHostId: s.id, remoteHostName: s.name });
    }
    setHostPickerOpen(false);
  }

  function openWizard() {
    setWizDraft(DEFAULT_WIZ);
    setWizStep('type');
    setDrawerMode('wizard');
  }

  function skipWizard(type: PfType) {
    setEditDraft({
      id: null,
      type,
      label: defaultLabel(type),
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
    setEditDraft(pfToDraft(pf, servers));
    setDrawerMode('edit');
    setCtxMenu(null);
  }

  function step(delta: 1 | -1) {
    const order = STEPS[wizDraft.type];
    const at = order.indexOf(wizStep);
    // A step the current type does not have can only come from switching type
    // part way, so fall back to the end the caller was heading for.
    if (at === -1) return setWizStep(delta === 1 ? 'label' : 'type');
    setWizStep(order[Math.min(order.length - 1, Math.max(0, at + delta))]);
  }
  const wizNext = () => step(1);
  const wizBack = () => step(-1);

  function finishWizard() {
    savePortForwarding(draftToPf(wizDraft));
    closeDrawer();
  }

  function saveEdit() {
    if (!editDraft) return;
    savePortForwarding(draftToPf(editDraft));
    closeDrawer();
  }

  function killAllTunnels() {
    setPanelCtx(null);
    setCtxMenu(null);
    for (const id of activeTunnelIds) {
      stopTunnel(id).catch((e: unknown) => console.error(e));
    }
  }

  function handleCardDoubleClick(pf: PortForwarding) {
    if (activeTunnelIds.has(pf.id)) {
      stopTunnel(pf.id).catch((e: unknown) => alert(String(e)));
    } else {
      startTunnel(pf).catch((e: unknown) => alert(String(e)));
    }
  }

  function handleConfirmDelete(id: string) {
    deletePortForwarding(id);
    setConfirmDeleteId(null);
    if (drawerMode === 'edit' && editDraft?.id === id) closeDrawer();
  }

  function wiz(d: Partial<Draft>) {
    setWizDraft((prev) => ({ ...prev, ...d }));
  }

  function ed(d: Partial<Draft>) {
    setEditDraft((prev) => prev ? { ...prev, ...d } : prev);
  }

  // ── Wizard step rendering ──────────────────────────────────

  function renderWizardStep() {
    const spec = WIZ[wizStep];
    const d = wizDraft;

    if (spec.kind === 'type') {
      return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">{spec.title}</p>
          <div className="pf-type-switcher">
            {(['local', 'remote', 'dynamic'] as PfType[]).map((t) => (
              <button
                key={t}
                className={`pf-type-tab${d.type === t ? ' active' : ''}`}
                onClick={() => wiz({ type: t })}
              >
                {typeLabel(t)}
              </button>
            ))}
          </div>
          <WizDiagram type={d.type} step={spec.diagram} />
          <p className="pf-wiz-desc">{TYPE_DESC[d.type]}</p>
          <button className="btn-primary btn-block" onClick={wizNext}>Continue</button>
          <button className="pf-skip-btn" onClick={() => skipWizard(d.type)}>Skip wizard</button>
        </div>
      );
    }

    if (spec.kind === 'host') {
      const idKey = spec.host === 'intermediate' ? 'intermediateHostId' : 'remoteHostId';
      const nameKey = spec.host === 'intermediate' ? 'intermediateHostName' : 'remoteHostName';
      return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">{spec.title}</p>
          <WizDiagram type={d.type} step={spec.diagram} />
          <p className="pf-wiz-desc">{spec.desc}</p>
          {d[idKey] ? (
            <>
              <HostChip
                name={d[nameKey]}
                onRemove={() => wiz({ [idKey]: '', [nameKey]: '' })}
              />
              <button className="btn-primary btn-block" onClick={wizNext}>Continue</button>
            </>
          ) : (
            <>
              <label className="pf-float-label pf-float-label-block">{spec.field} *</label>
              <button className="btn-secondary btn-block" onClick={() => openHostPicker(spec.host)}>
                Select host
              </button>
            </>
          )}
        </div>
      );
    }

    if (spec.kind === 'label') {
      return (
        <div className="pf-wiz-step">
          <p className="pf-wiz-title">{spec.title}</p>
          <WizDiagram type={d.type} step={spec.diagram} />
          <FloatField
            label="Label"
            value={d.label}
            onChange={(v) => wiz({ label: v })}
            placeholder={defaultLabel(d.type)}
          />
          <button className="btn-primary btn-block" onClick={finishWizard}>Done</button>
        </div>
      );
    }

    // 'fields': one or two numbered or named boxes, then Continue once every
    // required one is filled. The port steps and the destination steps are the
    // same shape with different boxes.
    const filled = spec.fields.every((f) => !f.required || d[f.key]);
    return (
      <div className="pf-wiz-step">
        <p className="pf-wiz-title">{spec.title}</p>
        <WizDiagram type={d.type} step={spec.diagram} />
        <p className="pf-wiz-desc">{spec.desc}</p>
        {spec.fields.map((f) => (
          <FloatField
            key={f.key}
            label={f.label}
            required={f.required}
            value={d[f.key]}
            onChange={(v) => wiz({ [f.key]: v })}
            type={f.numeric ? 'number' : undefined}
            placeholder={f.placeholder}
          />
        ))}
        <button className="btn-primary btn-block" onClick={wizNext} disabled={!filled}>
          Continue
        </button>
      </div>
    );
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

        <div className="pf-edit-header">
          <div className="pf-badge-lg" style={{ background: typeColor(t) + '30', color: typeColor(t), border: `1.5px solid ${typeColor(t)}` }}>
            {typeInitial(t)}
          </div>
          <div className="flex-1">
            <FloatField label="Label" value={editDraft.label} onChange={(v) => ed({ label: v })} placeholder={defaultLabel(t)} />
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
        {selectedHostId ? (
          <div className="pf-host-chip pf-block-gap">
            <div className="pf-float-field pf-host-chip-field">
              <label className="pf-float-label">{hostFieldLabel} *</label>
              <div className="pf-host-chip-name">{selectedHostName}</div>
            </div>
            <button className="pf-host-remove-btn" onClick={() => {
              if (t !== 'remote') ed({ intermediateHostId: '', intermediateHostName: '' });
              else ed({ remoteHostId: '', remoteHostName: '' });
            }}>Change</button>
          </div>
        ) : (
          <div className="pf-block-gap">
            <label className="pf-float-label pf-float-label-block">{hostFieldLabel} *</label>
            <button className="btn-secondary btn-block" onClick={() => openHostPicker(t !== 'remote' ? 'intermediate' : 'remote')}>
              Select {hostFieldLabel}
            </button>
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
        onContextMenu={(e) => { e.preventDefault(); setPanelCtx({ x: e.clientX, y: e.clientY }); }}
      >
        <div className="panel-title-row pf-title-row">
          <div className="panel-title">Port Forwarding</div>
        </div>
        <div className="pf-add-wrap">
          <div className="add-key-btn-group">
            <button className="add-key-btn-main btn-primary btn-sm" onClick={openWizard}>+ Add Forwarding</button>
            <button
              className="add-key-btn-caret btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); setAddDropdownOpen((v) => !v); }}
              aria-label="Select tunnel type"
            >
              <svg width="10" height="10" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
            </button>
          </div>
          {addDropdownOpen && (
            <>
              <div className="dropdown-scrim" onClick={() => setAddDropdownOpen(false)} />
              <div className="key-dropdown">
                <button onClick={() => { setAddDropdownOpen(false); skipWizard('local'); }}>Local Forwarding</button>
                <button onClick={() => { setAddDropdownOpen(false); skipWizard('remote'); }}>Remote Forwarding</button>
                <button onClick={() => { setAddDropdownOpen(false); skipWizard('dynamic'); }}>Dynamic Forwarding</button>
              </div>
            </>
          )}
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
              const active = activeTunnelIds.has(pf.id);
              return (
                <div
                  key={pf.id}
                  className={`pf-card${active ? ' pf-card-active' : ''}`}
                  {...cardKeys(() => handleCardDoubleClick(pf))}
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
                  <div className="card-body">
                    <div className="pf-card-header">
                      <span className="card-title">{pf.label}</span>
                      {active && <span className="pf-card-active-dot" />}
                    </div>
                    <span className="card-sub">{pfCardDesc(pf)}</span>
                  </div>
                  <button
                    className="card-edit-btn"
                    onClick={(e) => { e.stopPropagation(); editExisting(pf); }}
                    title="Edit"
                  >
                    <EditIcon />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Wizard / Edit Drawer */}
      {drawerMode !== 'none' && (
        <Drawer
          className="pf-drawer"
          onClose={closeDrawer}
          title={
            drawerMode === 'wizard'
              ? (wizStep === 'type' ? 'New Port Forwarding' : typeLabel(wizDraft.type) + ' Port Forwarding')
              : (editDraft?.id ? 'Edit Port Forwarding' : 'New Port Forwarding')
          }
        >
          <div className={`pf-drawer-body${hostPickerOpen ? ' pf-drawer-body-picker' : ''}`}>
            {hostPickerOpen ? (
              <>
                <button className="pf-back-btn" onClick={() => setHostPickerOpen(false)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15,18 9,12 15,6"/>
                  </svg>
                  Back
                </button>
                <p className="pf-wiz-title">Select host</p>
                <div className="pf-host-list">
                  {servers.length === 0
                    ? <p className="pf-host-empty">No hosts saved yet.</p>
                    : servers.map((s) => (
                      <button key={s.id} className="pf-host-item" onClick={() => selectPickerHost(s)}>
                        <span className="pf-host-item-name">{s.name}</span>
                        <span className="pf-host-item-addr">{s.host}:{s.port}</span>
                      </button>
                    ))
                  }
                </div>
              </>
            ) : drawerMode === 'wizard' ? (
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
            ) : drawerMode === 'edit' ? (
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
            ) : null}
          </div>
        </Drawer>
      )}

      {/* Panel background context menu */}
      {panelCtx && (
        <ContextMenu x={panelCtx.x} y={panelCtx.y} onClose={() => setPanelCtx(null)}>
          <button className="menu-item" onClick={() => { setPanelCtx(null); openWizard(); }}>Add Forwarding</button>
          <button className="menu-item" onClick={() => { setPanelCtx(null); skipWizard('local'); }}>Add Local Forwarding</button>
          <button className="menu-item" onClick={() => { setPanelCtx(null); skipWizard('remote'); }}>Add Remote Forwarding</button>
          <button className="menu-item" onClick={() => { setPanelCtx(null); skipWizard('dynamic'); }}>Add Dynamic Forwarding</button>
          {activeTunnelIds.size > 0 && (
            <>
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={killAllTunnels}>Kill all active tunnels</button>
            </>
          )}
        </ContextMenu>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button className="menu-item" onClick={() => { handleCardDoubleClick(ctxMenu.pf); setCtxMenu(null); }}>
            {activeTunnelIds.has(ctxMenu.pf.id) ? 'Deactivate' : 'Activate'}
          </button>
          {activeTunnelIds.size > 1 && (
            <button className="menu-item" onClick={killAllTunnels}>
              Kill all active
            </button>
          )}
          <button className="menu-item" onClick={() => editExisting(ctxMenu.pf)}>
            Edit
          </button>
          <div className="menu-divider" />
          <button className="menu-item menu-item-danger" onClick={() => { setConfirmDeleteId(ctxMenu.pf.id); setCtxMenu(null); }}>
            Delete
          </button>
        </ContextMenu>
      )}

      {/* Confirm delete */}
      {confirmDeleteId && (
        <ConfirmModal
          question="Delete this port forwarding rule?"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => handleConfirmDelete(confirmDeleteId)}
        />
      )}
    </>
  );
}
