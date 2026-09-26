//! What the monitor bar reads off a host: one shell line, and what it says.
//!
//! Linux only, since it reads `/proc`. The command prints each source under a
//! marker line so the parse never has to guess where one ends; each read
//! throws its errors away and the line ends in `true`, so a host missing one
//! piece still answers with the rest. What comes back is raw counters: the
//! rates, which need two samples, are worked out by the frontend.

use anyhow::{anyhow, Result};

/// Run on the far end once per sample.
pub const STATS_COMMAND: &str = "echo @stat; head -1 /proc/stat 2>/dev/null; \
     echo @mem; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null; \
     echo @load; cat /proc/loadavg 2>/dev/null; \
     echo @net; cat /proc/net/dev 2>/dev/null; \
     echo @virtual; ls /sys/devices/virtual/net 2>/dev/null; \
     echo @disk; df -Pk / 2>/dev/null | tail -1; true";

/// One reading. Counters are as the kernel keeps them; sizes are bytes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Sample {
    /// Jiffies since boot across every state, and the idle ones among them
    /// (iowait included: a CPU waiting on a disk is not busy computing).
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub mem_total: u64,
    pub mem_available: u64,
    pub load1: Option<f64>,
    /// Bytes through the host's physical interfaces since boot. Virtual ones
    /// (bridges, container veths, VPN tunnels) carry traffic that also
    /// crosses a physical one, and counting both would double it.
    pub net_rx: Option<u64>,
    pub net_tx: Option<u64>,
    /// The filesystem `/` is on.
    pub disk_used: Option<u64>,
    pub disk_size: Option<u64>,
}

/// The reading in the command's output.
///
/// No CPU line or no memory figures means `/proc` is not what Linux has, and
/// that is an error the bar reports once and stops asking about. Anything
/// else missing is only absent from the reading.
pub fn parse_sample(out: &str) -> Result<Sample> {
    let mut section = "";
    let mut cpu: Option<(u64, u64)> = None;
    let (mut mem_total, mut mem_available) = (None, None);
    let mut load1 = None;
    let mut interfaces: Vec<(String, u64, u64)> = Vec::new();
    let mut virtual_ifs: Vec<String> = Vec::new();
    let mut disk = None;

    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix('@') {
            section = name;
            continue;
        }
        match section {
            "stat" if line.starts_with("cpu ") => cpu = cpu_ticks(line),
            "mem" => {
                let mut parts = line.split_whitespace();
                let (key, value) = (parts.next(), parts.next().and_then(|v| v.parse::<u64>().ok()));
                match (key, value) {
                    (Some("MemTotal:"), Some(kb)) => mem_total = Some(kb * 1024),
                    (Some("MemAvailable:"), Some(kb)) => mem_available = Some(kb * 1024),
                    _ => {}
                }
            }
            "load" => load1 = line.split_whitespace().next().and_then(|l| l.parse().ok()),
            "net" => {
                if let Some((name, counters)) = line.split_once(':') {
                    let name = name.trim();
                    let fields: Vec<u64> =
                        counters.split_whitespace().filter_map(|f| f.parse().ok()).collect();
                    // Receive bytes first, transmit bytes ninth.
                    if name != "lo" && fields.len() >= 9 {
                        interfaces.push((name.to_string(), fields[0], fields[8]));
                    }
                }
            }
            "virtual" => virtual_ifs.extend(line.split_whitespace().map(str::to_string)),
            "disk" => {
                // Filesystem, 1024-blocks, Used, Available, Capacity, Mounted on.
                let fields: Vec<&str> = line.split_whitespace().collect();
                if let (Some(size), Some(used)) = (
                    fields.get(1).and_then(|f| f.parse::<u64>().ok()),
                    fields.get(2).and_then(|f| f.parse::<u64>().ok()),
                ) {
                    disk = Some((used * 1024, size * 1024));
                }
            }
            _ => {}
        }
    }

    // Physical interfaces only, unless there are none: inside a container
    // every interface is virtual, and its own traffic is still worth showing.
    let physical: Vec<&(String, u64, u64)> =
        interfaces.iter().filter(|(name, _, _)| !virtual_ifs.contains(name)).collect();
    let counted: Vec<&(String, u64, u64)> =
        if physical.is_empty() { interfaces.iter().collect() } else { physical };
    let net = (!counted.is_empty()).then(|| {
        counted.iter().fold((0u64, 0u64), |(rx, tx), (_, r, t)| (rx + r, tx + t))
    });

    let (cpu_total, cpu_idle) = cpu.ok_or_else(not_linux)?;
    let (mem_total, mem_available) = mem_total.zip(mem_available).ok_or_else(not_linux)?;
    Ok(Sample {
        cpu_total,
        cpu_idle,
        mem_total,
        mem_available,
        load1,
        net_rx: net.map(|(rx, _)| rx),
        net_tx: net.map(|(_, tx)| tx),
        disk_used: disk.map(|(used, _)| used),
        disk_size: disk.map(|(_, size)| size),
    })
}

/// The word the frontend looks for to stop asking.
pub const NOT_LINUX: &str = "This host has no Linux /proc to read";

fn not_linux() -> anyhow::Error {
    anyhow!(NOT_LINUX)
}

/// `cpu  user nice system idle iowait irq softirq steal ...` as total and idle.
///
/// Guest time is already counted in user and nice, so it is left out of the
/// total rather than counted twice.
fn cpu_ticks(line: &str) -> Option<(u64, u64)> {
    let fields: Vec<u64> = line.split_whitespace().skip(1).filter_map(|f| f.parse().ok()).collect();
    if fields.len() < 4 {
        return None;
    }
    let counted = &fields[..fields.len().min(8)];
    let total = counted.iter().sum();
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Output captured from a real host, trimmed.
    const HOST: &str = "@stat
cpu  4705 150 1120 16250 520 0 30 0 0 0
@mem
MemTotal:        4028292 kB
MemAvailable:    2861316 kB
@load
0.52 0.41 0.30 1/312 4242
@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  eth0: 1000000    2000    0    0    0     0          0         0   500000    1500    0    0    0     0       0          0
 wlan0:    2000      10    0    0    0     0          0         0     1000       5    0    0    0     0       0          0
@virtual
docker0
lo
wlan0
@disk
/dev/sda1         41152736 18493680  20545164      48% /
";

    #[test]
    fn a_linux_host_reads_every_figure() {
        let s = parse_sample(HOST).unwrap();
        assert_eq!(s.cpu_total, 4705 + 150 + 1120 + 16250 + 520 + 30);
        assert_eq!(s.cpu_idle, 16250 + 520);
        assert_eq!(s.mem_total, 4028292 * 1024);
        assert_eq!(s.mem_available, 2861316 * 1024);
        assert_eq!(s.load1, Some(0.52));
        // Loopback is the host talking to itself, and wlan0 is listed as
        // virtual here, so eth0 alone is counted.
        assert_eq!(s.net_rx, Some(1_000_000));
        assert_eq!(s.net_tx, Some(500_000));
        assert_eq!(s.disk_used, Some(18493680 * 1024));
        assert_eq!(s.disk_size, Some(41152736 * 1024));
    }

    #[test]
    fn a_missing_piece_is_absent_rather_than_a_failure() {
        let out = "@stat\ncpu 1 2 3 4\n@mem\nMemTotal: 100 kB\nMemAvailable: 50 kB\n@load\n@net\n@disk\n";
        let s = parse_sample(out).unwrap();
        assert_eq!(s.load1, None);
        assert_eq!(s.net_rx, None);
        assert_eq!(s.disk_size, None);
    }

    /// Inside a container every interface is virtual; its traffic is still
    /// the container's own and worth showing.
    #[test]
    fn a_host_whose_interfaces_are_all_virtual_counts_them_all() {
        let out = "@stat\ncpu 1 2 3 4\n@mem\nMemTotal: 100 kB\nMemAvailable: 50 kB\n@net\n\
                   eth0: 700 1 0 0 0 0 0 0 300 1 0 0 0 0 0 0\n@virtual\neth0\nlo\n";
        let s = parse_sample(out).unwrap();
        assert_eq!((s.net_rx, s.net_tx), (Some(700), Some(300)));
    }

    #[test]
    fn windows_line_endings_read_the_same() {
        assert_eq!(parse_sample(&HOST.replace('\n', "\r\n")).unwrap(), parse_sample(HOST).unwrap());
    }

    /// What a Mac or a BSD box answers: the markers, and nothing from /proc.
    #[test]
    fn a_host_without_proc_says_so() {
        let out = "@stat\n@mem\n@load\n@net\n@disk\n/dev/disk1s1 488245288 2000 400000 1% /\n";
        let e = parse_sample(out).unwrap_err().to_string();
        assert_eq!(e, NOT_LINUX);
    }

    #[test]
    fn guest_time_is_not_counted_twice() {
        let (total, idle) = cpu_ticks("cpu  10 0 10 70 5 0 5 0 99 99").unwrap();
        assert_eq!((total, idle), (100, 75));
    }
}
