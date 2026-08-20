import { useEffect, useMemo, useRef, useState } from 'react';
import * as ipc from '../ipc';
import type { AuthPromptEvent } from '../types';
import Modal from './shared/Modal';

interface Props {
  event: AuthPromptEvent;
  onResolved: (requestId: string) => void;
}

interface MenuOption {
  value: string;
  label: string;
}

/**
 * Pulls a numbered menu out of server-supplied text, e.g. Duo's
 *
 *   1. Duo Push to XXX-XXX-1234
 *   2. Phone call to XXX-XXX-1234
 *
 * Returns the options plus the text with those lines removed, so the remaining
 * wording can still be shown above the buttons.
 *
 * The text is chosen by the server, so anything that does not match cleanly is
 * left alone and the plain input is used instead.
 */
function extractMenu(text: string): { options: MenuOption[]; rest: string } {
  const options: MenuOption[] = [];
  const rest: string[] = [];

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/);
    if (match) {
      options.push({ value: match[1], label: match[2] });
    } else {
      rest.push(line);
    }
  }

  // One lone numbered line is more likely prose than a menu.
  if (options.length < 2) return { options: [], rest: text };

  return { options, rest: rest.join('\n').trim() };
}

export default function AuthPromptModal({ event, onResolved }: Props) {
  const [answers, setAnswers] = useState<string[]>(() => event.prompts.map(() => ''));
  const [submitted, setSubmitted] = useState(false);
  const [showPasscode, setShowPasscode] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  const single = event.prompts.length === 1;

  // Duo puts the menu in the instructions on some setups and in the prompt
  // label on others, so consider both.
  const { options, instructionsText, promptLabel } = useMemo(() => {
    if (!single) {
      return { options: [], instructionsText: event.instructions, promptLabel: '' };
    }
    const fromInstructions = extractMenu(event.instructions);
    if (fromInstructions.options.length > 0) {
      return {
        options: fromInstructions.options,
        instructionsText: fromInstructions.rest,
        promptLabel: event.prompts[0].prompt,
      };
    }
    const fromPrompt = extractMenu(event.prompts[0].prompt);
    return {
      options: fromPrompt.options,
      instructionsText: event.instructions,
      promptLabel: fromPrompt.options.length > 0 ? fromPrompt.rest : event.prompts[0].prompt,
    };
  }, [event, single]);

  // With a menu up the buttons are the primary action, so don't steal focus
  // into the passcode field until the user asks for it.
  const menuShown = options.length > 0;
  useEffect(() => {
    if (!menuShown || showPasscode) firstRef.current?.focus();
  }, [menuShown, showPasscode]);

  const respond = async (responses: string[] | null) => {
    if (submitted) return;
    setSubmitted(true);
    onResolved(event.request_id);
    try {
      await ipc.respondAuthPrompt(event.request_id, responses);
    } catch (err) {
      console.error('Failed to answer auth prompt', err);
    }
  };

  const setAnswer = (i: number, value: string) =>
    setAnswers((prev) => prev.map((a, n) => (n === i ? value : a)));

  return (
    <Modal
      className="authprompt-modal"
      zIndex={300}
      /* Server-supplied wording, rendered as plain text. */
      title={event.name.trim() || 'Two-factor authentication'}
      subtitle={`${event.username}@${event.host}`}
      onSubmit={(e) => { e.preventDefault(); respond(answers); }}
    >
      {instructionsText.trim() && (
        <p className="authprompt-instructions">{instructionsText.trim()}</p>
      )}

      {options.length > 0 && (
        <div className="authprompt-options">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="authprompt-option"
              disabled={submitted}
              onClick={() => respond([opt.value])}
            >
              <span className="authprompt-option-label">{opt.label}</span>
              <span className="authprompt-option-key">{opt.value}</span>
            </button>
          ))}
        </div>
      )}

      {/* Menu on screen: the passcode field stays out of the way until asked
          for. It is still needed on the round after picking SMS, when Duo
          re-sends the same menu and expects the texted code. */}
      {menuShown && !showPasscode && (
        <button
          type="button"
          className="link-btn authprompt-passcode-toggle"
          disabled={submitted}
          onClick={() => setShowPasscode(true)}
        >
          Enter a passcode instead
        </button>
      )}

      {(!menuShown || showPasscode) && event.prompts.map((p, i) => {
        const label = single && menuShown
          ? (promptLabel.trim() || 'Passcode')
          : (p.prompt.trim() || 'Response');
        return (
          <div className="authprompt-field" key={i}>
            <label htmlFor={`authprompt-${i}`}>{label}</label>
            <input
              id={`authprompt-${i}`}
              ref={i === 0 ? firstRef : undefined}
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              onChange={(e) => setAnswer(i, e.target.value)}
              autoComplete={!p.echo && single ? 'one-time-code' : 'off'}
              spellCheck={false}
              disabled={submitted}
            />
          </div>
        );
      })}

      <div className="modal-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={submitted}
          onClick={() => respond(null)}
        >
          Cancel
        </button>
        {(!menuShown || showPasscode) && (
          <button
            type="submit"
            className="btn-primary"
            disabled={submitted || (menuShown && answers.every((a) => !a.trim()))}
          >
            Submit
          </button>
        )}
      </div>
    </Modal>
  );
}
