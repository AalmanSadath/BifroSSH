/**
 * Keyboard equivalents for a card that behaves as a button.
 *
 * The cards in Hosts, Keychain and Port Forwarding are divs, because each
 * holds several lines and its own context menu, and a button cannot contain
 * one. That left them out of the tab order entirely, so the only keyboard
 * route to a host, a key or a rule was the edit pencil inside it, which is
 * invisible until hovered.
 *
 * Deliberately no `onClick`: the three panels disagree about what a click
 * means, single in Keychain and double in the other two, and that stays their
 * business. What Enter and Space do is the card's primary action, whichever
 * gesture the mouse uses to reach it.
 *
 * The edit button inside each card stays in the tab order beside it. In Hosts
 * and Port Forwarding it plainly has to, since the card connects and the
 * pencil edits. In Keychain the two do the same thing, and taking the pencil
 * out on those grounds was wrong: what made the second stop feel like a
 * mistake was that the pencil is invisible until hovered, so it was reached
 * and could not be seen. That is fixed in the stylesheet, and the same number
 * of stops now looks the same in all three panels.
 */
export function cardKeys(onActivate: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
