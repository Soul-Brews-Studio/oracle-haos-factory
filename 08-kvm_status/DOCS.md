# KVM Status

Disk capacity and device health for the Home Assistant OS host this add-on runs
on. Free space, memory, load, board and kernel, and the state of every installed
add-on — read live, on every poll.

## Configuration

| Option | Meaning |
|---|---|
| `refresh_seconds` | How often the page re-polls. Default 5. |
| `disk_warn_percent` | Disk bar turns amber at or above this. Default 80. |
| `disk_critical_percent` | Disk bar turns red at or above this. Default 90. |

## Where each number comes from

| Panel | Source |
|---|---|
| Disk free / used / total, data disk | Supervisor `/host/info` and `/os/info` |
| Memory, load, cores | the host kernel, via `/proc/meminfo` and `/proc/loadavg` |
| Board, kernel, OS version, uptime | Supervisor `/host/info`, `/os/info` |
| Supervisor version, arch, healthy | Supervisor `/supervisor/info` |
| Add-on states | Supervisor `/supervisor/info` |

Memory and load come from `/proc` rather than the Supervisor API for a measured
reason: an add-on holding only the `hassio_api` grant gets **403** from both
`/supervisor/stats` and `/core/stats`. The alternatives were a broader
permission or asking the kernel. The kernel is both cheaper and more correct —
those endpoints report a *container's* usage, and a page headed "device status"
should be showing the host. An add-on container shares the host's `/proc`, and
the figure was checked against the host's own `MemTotal` before being trusted.

## Nothing here is estimated

A value the host does not publish renders as **—**, never as `0`. On a page
whose job is to tell you whether a disk is filling up, a fake zero is
indistinguishable from good news. `disk_life_time` is the usual example: this
board does not report SSD wear, so it reads "not reported" rather than "0%".

`used_percent` is derived as `used / total`, not `100 − free / total`, because
Supervisor reports used and free independently and they need not sum to total.

## Health

`GET /api/health` reports **observed state**, not configuration:

| status | meaning |
|---|---|
| `starting` | no poll has been attempted yet |
| `ok` | the last poll reached Supervisor |
| `degraded` | polls have run and some failed; `last_error` names the most recent |
| `misconfigured` | `SUPERVISOR_TOKEN` is absent — `hassio_api: true` is missing from `config.yaml` |

It deliberately does not echo the options it was handed. A health field that
reports its own configuration stays green through a total outage.

## Read-only

This add-on performs no writes. It holds `hassio_api: true` for reading
`/host/info`, `/os/info` and `/supervisor/info`, and requests no Home Assistant
Core access at all.
