//! A CSV reader, for the exports other clients write.
//!
//! Written here rather than taken from a crate: the whole of what is needed is
//! below, and a new dependency has to be mirrored into the two offline
//! dependency manifests the Flatpak build reads (see `patches/README.md`),
//! which is a larger cost than the code.
//!
//! RFC 4180 as the world actually writes it: quoted fields may hold commas,
//! newlines and doubled quotes; rows may end with CRLF or LF; a UTF-8 BOM at
//! the start is skipped; a row may be short or long compared to the header,
//! and that is the caller's problem rather than an error.

/// The rows of a CSV document, each a list of fields, blank lines dropped.
pub(super) fn rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    // Inside quotes, a comma and a newline are data rather than separators.
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();

    while let Some(c) = chars.next() {
        if quoted {
            match c {
                // Two quotes in a row are one quote; a lone one ends the field.
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                end_row(&mut rows, &mut row, &mut field);
            }
            '\n' => end_row(&mut rows, &mut row, &mut field),
            _ => field.push(c),
        }
    }
    end_row(&mut rows, &mut row, &mut field);
    rows
}

/// A row is kept unless it holds nothing at all: a trailing newline, and a
/// blank line between two records, are formatting rather than data.
fn end_row(rows: &mut Vec<Vec<String>>, row: &mut Vec<String>, field: &mut String) {
    row.push(std::mem::take(field));
    let has_content = row.iter().any(|f| !f.trim().is_empty());
    if has_content {
        rows.push(std::mem::take(row));
    } else {
        row.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_rows_split_on_commas() {
        assert_eq!(
            rows("a,b,c\n1,2,3\n"),
            vec![vec!["a", "b", "c"], vec!["1", "2", "3"]]
        );
    }

    #[test]
    fn a_quoted_field_may_hold_a_comma() {
        assert_eq!(
            rows("name,group\nweb,\"Prod, EU\"\n"),
            vec![vec!["name", "group"], vec!["web", "Prod, EU"]]
        );
    }

    #[test]
    fn two_quotes_are_one_quote() {
        assert_eq!(rows(r#""say ""hi""",b"#), vec![vec![r#"say "hi""#, "b"]]);
    }

    #[test]
    fn a_quoted_field_may_hold_a_newline() {
        assert_eq!(
            rows("a,\"line one\nline two\"\nb,c"),
            vec![vec!["a", "line one\nline two"], vec!["b", "c"]]
        );
    }

    #[test]
    fn windows_endings_and_a_byte_order_mark_are_not_data() {
        assert_eq!(
            rows("\u{feff}a,b\r\n1,2\r\n"),
            vec![vec!["a", "b"], vec!["1", "2"]]
        );
    }

    /// A row with fewer or more fields than the header is normal in an export
    /// written by hand, and the reader is not the place to refuse it.
    #[test]
    fn a_ragged_row_is_returned_as_it_is() {
        assert_eq!(
            rows("a,b,c\n1,2\n3,4,5,6"),
            vec![vec!["a", "b", "c"], vec!["1", "2"], vec!["3", "4", "5", "6"]]
        );
    }

    #[test]
    fn blank_lines_are_dropped_and_an_empty_document_has_no_rows() {
        assert_eq!(rows("a,b\n\n\n1,2\n\n"), vec![vec!["a", "b"], vec!["1", "2"]]);
        assert!(rows("").is_empty());
        assert!(rows("\n \n").is_empty());
    }

    /// An empty field between two commas is a field, not a missing one.
    #[test]
    fn empty_fields_are_kept() {
        assert_eq!(rows("a,,c"), vec![vec!["a", "", "c"]]);
    }
}
