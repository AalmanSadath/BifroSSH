//! Taking the app's own typing back out of what the terminal shows.
//!
//! Used for one thing: the startup command a host runs on connect. It is
//! typed at the shell, so the shell echoes it, and nothing on the far side
//! can be asked not to; see `EchoFilter` for why removing it here is what is
//! left.

/// Takes the app's own typing back out of what the terminal shows.
///
/// A startup command is typed at the shell, so the shell echoes it above the
/// first prompt, and the shell integration snippet is a long line to find
/// sitting there. Clearing the screen afterwards would take the login banner
/// with it, and nothing on the far side can be asked not to echo: readline
/// displays whatever it reads. What is left is to remove it here, where the
/// exact bytes that were sent are known.
///
/// Escape sequences pass through untouched even in the middle of a match: they
/// draw nothing, and one of them is the mark that tells a tab a command has
/// started. Carriage returns and newlines inside the echo are held with it,
/// since a line longer than the window comes back wrapped. Anything else that
/// does not match gives the held bytes back and starts looking again, so a
/// failure to recognise the echo costs nothing but the echo staying.
pub(super) struct EchoFilter {
    want: Vec<u8>,
    /// Bytes matched so far, kept in case this turns out not to be the echo.
    held: Vec<u8>,
    at: usize,
    esc: Escape,
    /// The carriage return of the Enter that ran it, already swallowed. The
    /// newline that follows can land in the next chunk.
    saw_cr: bool,
    done: bool,
}

/// Where a pass-through escape sequence has got to.
#[derive(PartialEq)]
enum Escape {
    No,
    /// ESC seen; what follows says which kind it is.
    Start,
    /// `ESC [ ... final`, the final being one of `@` through `~`.
    Csi,
    /// `ESC ] ... BEL` or `ESC ] ... ESC \`, which is how the OSC marks end.
    Osc,
}

impl EchoFilter {
    pub(super) fn new(command: &str) -> Self {
        Self {
            want: command.as_bytes().to_vec(),
            held: Vec::new(),
            at: 0,
            esc: Escape::No,
            saw_cr: false,
            done: false,
        }
    }

    /// Everything still worth showing, with the echo taken out of it.
    pub(super) fn feed(&mut self, data: &[u8], out: &mut Vec<u8>) {
        if self.done {
            out.extend_from_slice(data);
            return;
        }
        for (i, &b) in data.iter().enumerate() {
            if self.esc != Escape::No {
                out.push(b);
                self.step_escape(b);
                continue;
            }
            if b == 0x1b {
                out.push(b);
                self.esc = Escape::Start;
                continue;
            }
            // The whole command has been seen; the Enter that ran it goes
            // with it, and everything after that is the session again.
            if self.at == self.want.len() {
                self.held.clear();
                if b == b'\r' && !self.saw_cr {
                    self.saw_cr = true;
                    continue;
                }
                self.done = true;
                let rest = if b == b'\n' { i + 1 } else { i };
                out.extend_from_slice(&data[rest..]);
                return;
            }
            if b == self.want[self.at] {
                self.held.push(b);
                self.at += 1;
            } else if (b == b'\r' || b == b'\n') && self.at > 0 {
                // A line longer than the window comes back wrapped.
                self.held.push(b);
            } else {
                out.append(&mut self.held);
                self.at = 0;
                // The byte that broke the match may start the next one.
                if b == self.want[0] {
                    self.held.push(b);
                    self.at = 1;
                } else {
                    out.push(b);
                }
            }
        }
    }

    fn step_escape(&mut self, b: u8) {
        self.esc = match self.esc {
            Escape::Start if b == b'[' => Escape::Csi,
            Escape::Start if b == b']' => Escape::Osc,
            Escape::Start => Escape::No,
            Escape::Csi if (0x40..=0x7e).contains(&b) => Escape::No,
            Escape::Csi => Escape::Csi,
            Escape::Osc if b == 0x07 || b == b'\\' => Escape::No,
            Escape::Osc => Escape::Osc,
            Escape::No => Escape::No,
        };
    }

    /// Whether the echo has been found and the filter is now passing
    /// everything through.
    pub(super) fn is_done(&self) -> bool {
        self.done
    }

    /// Whatever was being held, back where it was. Called when the echo never
    /// arrived, so the wait is over and nothing was taken.
    pub(super) fn give_up(&mut self, out: &mut Vec<u8>) {
        if self.done {
            return;
        }
        out.append(&mut self.held);
        self.at = 0;
        self.done = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn filtered(command: &str, chunks: &[&[u8]]) -> String {
        let mut filter = EchoFilter::new(command);
        let mut out = Vec::new();
        for chunk in chunks {
            filter.feed(chunk, &mut out);
        }
        filter.give_up(&mut out);
        String::from_utf8(out).unwrap()
    }

    /// The line the app typed is taken out; the prompt it was typed at, and
    /// everything the command then said, are not.
    #[test]
    fn the_apps_own_typing_is_taken_back_out() {
        assert_eq!(
            filtered("echo hi", &[b"pi@box:~ $ echo hi\r\nhi\r\npi@box:~ $ "]),
            "pi@box:~ $ hi\r\npi@box:~ $ "
        );
    }

    /// It arrives in whatever pieces the network felt like.
    #[test]
    fn an_echo_split_across_chunks_is_still_recognised() {
        assert_eq!(filtered("echo hi", &[b"$ ec", b"ho ", b"hi\r\nhi\r\n"]), "$ hi\r\n");
    }

    /// A line longer than the window comes back wrapped, and the wrap belongs
    /// to the echo rather than to the session.
    #[test]
    fn a_wrapped_echo_goes_with_its_wrapping() {
        assert_eq!(filtered("abcdef", &[b"$ abc\r\ndef\r\ndone\r\n"]), "$ done\r\n");
    }

    /// Escape sequences draw nothing and one of them is the mark that says a
    /// command has started, so they pass through even mid-match.
    #[test]
    fn escape_sequences_pass_through_the_match() {
        let out = filtered("ls", &[b"$ \x1b[32ml\x1b]133;C\x07s\r\nfile\r\n"]);
        assert_eq!(out, "$ \x1b[32m\x1b]133;C\x07file\r\n");
    }

    /// Something that starts like the echo and turns out not to be is given
    /// back whole, in the order it arrived.
    #[test]
    fn output_that_only_looked_like_the_echo_is_given_back() {
        assert_eq!(filtered("echo hi", &[b"ech no\r\n"]), "ech no\r\n");
        // And the real echo is still found after the false start.
        assert_eq!(filtered("hi", &[b"h no, hi\r\nthere"]), "h no, there");
    }

    /// An echo that never comes holds nothing back.
    #[test]
    fn a_startup_command_that_is_never_echoed_costs_nothing() {
        assert_eq!(filtered("echo hi", &[b"motd\r\necho h"]), "motd\r\necho h");
    }
}
