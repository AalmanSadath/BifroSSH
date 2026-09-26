//! Unix timestamps.

use crate::{Error, Result};
use core::fmt;
use core::fmt::Formatter;
use encoding::{Decode, Encode, Reader, Writer};

#[cfg(feature = "std")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Maximum allowed value for a Unix timestamp.
pub const MAX_SECS: u64 = i64::MAX as u64;

// PATCH (BifroSSH): OpenSSH writes a certificate valid "forever" with
// valid_before = 0xFFFFFFFFFFFFFFFF, which is what `ssh-keygen -s` does when
// no -V is given, so it is the most common certificate there is. Upstream
// 0.6.7 caps timestamps at i64::MAX and refuses to decode one. This value is
// accepted as itself; its SystemTime is the farthest one the platform holds.
/// The `valid_before` of a certificate that never expires.
pub const FOREVER: u64 = u64::MAX;

/// The SystemTime shown for [`FOREVER`]: i64::MAX seconds where the platform
/// can hold it, else the end of year 9999, which every platform can.
#[cfg(feature = "std")]
fn forever_time() -> SystemTime {
    UNIX_EPOCH
        .checked_add(Duration::from_secs(MAX_SECS))
        .or_else(|| UNIX_EPOCH.checked_add(Duration::from_secs(253_402_300_799)))
        .unwrap_or(UNIX_EPOCH)
}

/// Unix timestamps as used in OpenSSH certificates.
#[derive(Copy, Clone, Eq, PartialEq, PartialOrd, Ord)]
pub(super) struct UnixTime {
    /// Number of seconds since the Unix epoch
    secs: u64,

    /// System time corresponding to this Unix timestamp
    #[cfg(feature = "std")]
    time: SystemTime,
}

impl UnixTime {
    /// Create a new Unix timestamp.
    ///
    /// `secs` is the number of seconds since the Unix epoch and must be less
    /// than or equal to `i64::MAX`.
    #[cfg(not(feature = "std"))]
    pub fn new(secs: u64) -> Result<Self> {
        if secs <= MAX_SECS || secs == FOREVER {
            Ok(Self { secs })
        } else {
            Err(Error::Time)
        }
    }

    /// Create a new Unix timestamp.
    ///
    /// This version requires `std` and ensures there's a valid `SystemTime`
    /// representation with an infallible conversion (which also improves the
    /// `Debug` output)
    #[cfg(feature = "std")]
    pub fn new(secs: u64) -> Result<Self> {
        if secs == FOREVER {
            return Ok(Self { secs, time: forever_time() });
        }
        if secs > MAX_SECS {
            return Err(Error::Time);
        }

        match UNIX_EPOCH.checked_add(Duration::from_secs(secs)) {
            Some(time) => Ok(Self { secs, time }),
            None => Err(Error::Time),
        }
    }

    /// Get the current time as a Unix timestamp.
    #[cfg(feature = "std")]
    pub fn now() -> Result<Self> {
        SystemTime::now().try_into()
    }
}

impl Decode for UnixTime {
    type Error = Error;

    fn decode(reader: &mut impl Reader) -> Result<Self> {
        u64::decode(reader)?.try_into()
    }
}

impl Encode for UnixTime {
    fn encoded_len(&self) -> encoding::Result<usize> {
        self.secs.encoded_len()
    }

    fn encode(&self, writer: &mut impl Writer) -> encoding::Result<()> {
        self.secs.encode(writer)?;
        Ok(())
    }
}

impl From<UnixTime> for u64 {
    fn from(unix_time: UnixTime) -> u64 {
        unix_time.secs
    }
}

#[cfg(feature = "std")]
impl From<UnixTime> for SystemTime {
    fn from(unix_time: UnixTime) -> SystemTime {
        unix_time.time
    }
}

impl TryFrom<u64> for UnixTime {
    type Error = Error;

    fn try_from(unix_secs: u64) -> Result<UnixTime> {
        Self::new(unix_secs)
    }
}

#[cfg(feature = "std")]
impl TryFrom<SystemTime> for UnixTime {
    type Error = Error;

    fn try_from(time: SystemTime) -> Result<UnixTime> {
        Self::new(time.duration_since(UNIX_EPOCH)?.as_secs())
    }
}

impl fmt::Debug for UnixTime {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.secs)
    }
}

#[cfg(test)]
mod tests {
    use super::{UnixTime, MAX_SECS};
    use crate::Error;

    #[test]
    fn new_with_max_secs() {
        assert!(UnixTime::new(MAX_SECS).is_ok());
    }

    #[test]
    fn new_over_max_secs_returns_error() {
        assert_eq!(UnixTime::new(MAX_SECS + 1), Err(Error::Time));
    }
}
