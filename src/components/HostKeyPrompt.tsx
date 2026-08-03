import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { HostKeyDecision, HostKeyPromptEvent } from '../types';

interface Props {
  event: HostKeyPromptEvent;
  onResolved: (requestId: string) => void;
}

export default function HostKeyPrompt({ event, onResolved }: Props) {
  const [confirmText, setConfirmText] = useState('');
  const changed = event.status !== 'unknown';
  const target = event.username
    ? `${event.username}@${event.host}:${event.port}`
    : `${event.host}:${event.port}`;

  // Replacing a stored key is the one action that can talk an attacker's key
  // into known_hosts, so it stays behind typing the hostname.
  const canReplace = confirmText.trim() === event.host;

  const respond = async (decision: HostKeyDecision) => {
    onResolved(event.request_id);
    try {
      await invoke('respond_host_key', { requestId: event.request_id, decision });
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
    <div className="modal-overlay" style={{ zIndex: 300 }}>
      <div className={`modal hostkey-modal${changed ? ' hostkey-modal-danger' : ''}`}>
        <div className="modal-header">
          <div>
            <h2>
              {event.status === 'revoked'
                ? 'Revoked host key'
                : changed
                  ? 'Host key has changed'
                  : 'Unknown host key'}
              {event.is_jump && ' on a jump host'}
            </h2>
            <div className="modal-subtitle">{target}</div>
            {event.is_jump && (
              <div className="modal-subtitle">
                A jump host on the way to the server you asked for. It has to be
                trusted before it can carry that connection.
              </div>
            )}
          </div>
        </div>

        {changed ? (
          <>
            <div className="hostkey-warn">
              <strong>REMOTE HOST IDENTIFICATION HAS CHANGED.</strong>
              <p>
                {event.status === 'revoked'
                  ? 'This key is marked as revoked in your known_hosts file. It must not be trusted.'
                  : 'Someone could be eavesdropping on you right now (man-in-the-middle attack). It is also possible the server’s host key was just changed — check with whoever administers it before continuing.'}
              </p>
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

            {event.source && (
              <p className="form-hint">
                Stored in the {event.source} known_hosts file
                {event.line ? `, line ${event.line}` : ''}.
              </p>
            )}

            {event.status !== 'revoked' && (
              <div className="hostkey-confirm">
                <label htmlFor="hostkey-confirm-input">
                  To replace the stored key, type <code>{event.host}</code>
                </label>
                <input
                  id="hostkey-confirm-input"
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
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
                  className="btn-danger"
                  disabled={!canReplace}
                  onClick={() => respond('replace')}
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
      </div>
    </div>
  );
}
