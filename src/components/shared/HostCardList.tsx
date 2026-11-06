import type { ReactNode } from 'react';
import { useAppStore } from '../../store/appStore';
import { UNGROUPED, groupNames, hostSections } from '../../hosts';
import type { Server } from '../../types';
import OsIcon from '../OsIcon';
import { cardKeys } from './cardKeys';

interface HostCardProps {
  server: Server;
  /** Outlined in the accent: the host this page is connected to. */
  active?: boolean;
  /** Faded and not clickable, while it connects. */
  dim?: boolean;
  /** At the right of the card: "Connecting…", "● Active". */
  badge?: ReactNode;
  /** The card's primary action, for Enter and Space as well. */
  onActivate: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  title?: string;
}

/**
 * A host as the Hosts page draws it, for the pages that pick a host to work
 * on: the OS tile, the name, and who it logs in as and where. The Hosts page
 * keeps its own card, which also carries tags, notes, probes and an edit
 * button; this one shares its classes so the two look the same.
 */
export function HostCard({ server, active, dim, badge, onActivate, onClick, onDoubleClick, title }: HostCardProps) {
  const { identities } = useAppStore();
  const user = server.username ?? identities.find((i) => i.id === server.identity_id)?.username ?? 'ssh';
  return (
    <div
      className={`host-card${active ? ' host-card-active' : ''}${dim ? ' host-card-dim' : ''}`}
      {...cardKeys(onActivate)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <div className="host-card-icon">
        <OsIcon os={server.os} size={28} />
      </div>
      <div className="host-card-info">
        <div className="host-card-name-row">
          <span className="card-title">{server.name}</span>
        </div>
        <span className="card-sub">{user} · {server.host}:{server.port}</span>
      </div>
      {badge && <span className="host-card-badge">{badge}</span>}
    </div>
  );
}

interface HostCardListProps {
  servers: Server[];
  query: string;
  /** Lays the cards of one group out: a grid, or a single column. */
  className: string;
  render: (server: Server) => ReactNode;
}

/**
 * Hosts under the same group headings, in the same order, as on the Hosts
 * page, so a host is found in the same place on every page that lists them.
 */
export default function HostCardList({ servers, query, className, render }: HostCardListProps) {
  if (servers.length === 0) return <p className="list-empty">No hosts yet. Add one in Hosts.</p>;
  const sections = hostSections(servers, query, null);
  if (sections.length === 0) return <p className="list-empty">No hosts match.</p>;
  // One nameless section, when nothing is grouped, needs no heading.
  const titled = groupNames(servers).length > 0;
  return (
    <>
      {sections.map((section) => (
        <div key={section.group ?? ''} className="hosts-section">
          {titled && <div className="hosts-group-title">{section.group ?? UNGROUPED}</div>}
          <div className={className}>{section.servers.map(render)}</div>
        </div>
      ))}
    </>
  );
}
