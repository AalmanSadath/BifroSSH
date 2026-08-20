import { useEffect, useState } from 'react';
import * as ipc from '../ipc';
import type { HostKeyDecision, HostKeyPromptEvent } from '../types';
import Modal from './shared/Modal';

interface Props {
  event: HostKeyPromptEvent;
  onResolved: (requestId: string) => void;
}

export default function HostKeyPrompt({ event, onResolved }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  /// Raised when Replace is pressed without the tick, to point at the thing
  /// standing in the way. Clears itself so pressing again flashes again.
  const [nudge, setNudge] = useState(false);
  const changed = event.status !== 'unknown';
  const target = event.username
    ? `${event.username}@${event.host}:${event.port}`
    : `${event.host}:${event.port}`;

  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(false), 1200);
    return () => clearTimeout(t);
  }, [nudge]);

  const respond = async (decision: HostKeyDecision) => {
    onResolved(event.request_id);
    try {
      await ipc.respondHostKey(event.request_id, decision);
    } catch (err) {
      console.error('Failed to answer host key prompt', err);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        respond('reject');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.request_id]);

  return (
    <Modal
      className={`hostkey-modal${changed ? ' hostkey-modal-danger' : ''}`}
      zIndex={300}
      title={
        <>
          {event.status === 'revoked'
            ? 'Revoked host key'
            : changed
              ? 'Host key has changed'
              : 'Unknown host key'}
          {event.is_jump && ' on a jump host'}
        </>
      }
      subtitle={[
        target,
        event.is_jump &&
          'A jump host on the way to the server you asked for. It has to be trusted before it can carry that connection.',
      ]}
    >
      {changed ? (
        <>
          <div className="hostkey-warn">
            {event.status === 'revoked'
              ? 'This key is marked revoked. It must not be trusted.'
              : 'Someone may be intercepting this connection, or the key was changed legitimately. Check with whoever runs the server.'}
          </div>

          <div className="hostkey-compare">
            <div>
              <span className="hostkey-label">Stored</span>
              <div className="hostkey-fp">{event.existing_fingerprint}</div>
              <span className="hostkey-meta">{event.existing_key_type}</span>
            </div>
            <div>
              <span className="hostkey-label">Offered now</span>
              <div className="hostkey-fp">{event.fingerprint}</div>
              <span className="hostkey-meta">{event.key_type}</span>
            </div>
          </div>

          {event.status !== 'revoked' && (
            <label className={`hostkey-confirm${nudge ? ' hostkey-confirm-nudge' : ''}`}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => { setAcknowledged(e.target.checked); setNudge(false); }}
              />
              {/* Replacing a stored key is the one action here that can write
                  an attacker's key into known_hosts, so it takes a deliberate
                  tick rather than one click from arriving at the dialog. */}
              I confirm replacing the host key
            </label>
          )}

          {event.source && (
            <p className="form-hint">
              Stored in the {event.source} known_hosts file
              {event.line ? `, line ${event.line}` : ''}.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="hostkey-body">
            The authenticity of <strong>{event.host}</strong> can&apos;t be established. Confirm
            this fingerprint matches the server before trusting it.
          </p>
          <div>
            <span className="hostkey-label">{event.key_type} key fingerprint</span>
            <div className="hostkey-fp">{event.fingerprint}</div>
          </div>
          <p className="form-hint">
            On the server, check with:
            <br />
            <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
          </p>
        </>
      )}

      <div className="modal-actions">
        {changed ? (
          <>
            <button className="btn-primary" autoFocus onClick={() => respond('reject')}>
              Cancel
            </button>
            {event.status !== 'revoked' && (
              <button
                className={`btn-danger${acknowledged ? '' : ' btn-held'}`}
                aria-disabled={!acknowledged}
                onClick={() => (acknowledged ? respond('replace') : setNudge(true))}
              >
                Replace stored key
              </button>
            )}
          </>
        ) : (
          <>
            <button className="btn-secondary" onClick={() => respond('reject')}>
              Reject
            </button>
            <button className="btn-secondary" onClick={() => respond('once')}>
              Connect once
            </button>
            <button className="btn-primary" autoFocus onClick={() => respond('trust')}>
              Trust &amp; save
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
