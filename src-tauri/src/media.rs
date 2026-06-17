//! Media session bridge built on the Windows System Media Transport Controls
//! (SMTC). This is the Windows equivalent of MPRIS on Linux: it exposes
//! metadata, album art, timeline and transport controls for whatever app is
//! currently playing (Spotify, browsers, etc.).

use base64::Engine as _;
use windows::core::{Error, Result};
use windows::Foundation::{DateTime, TimeSpan};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Smtc,
    GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProps,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// Lightweight snapshot of the active media session. Album art is fetched
/// separately (see [`art`]) so the once-per-second poll stays cheap.
#[derive(serde::Serialize, Default)]
pub struct NowPlaying {
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    /// Playback position in seconds (0 when the player doesn't report it).
    pub position_secs: f64,
    /// Track duration in seconds (0 when unavailable).
    pub duration_secs: f64,
}

/// Initialize COM as multi-threaded for the current worker thread. Safe to call
/// repeatedly; subsequent calls return `S_FALSE` or `RPC_E_CHANGED_MODE`.
fn ensure_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// WinRT `TimeSpan` is measured in 100-nanosecond ticks.
fn ts_to_secs(ts: TimeSpan) -> f64 {
    ts.Duration as f64 / 10_000_000.0
}

/// Seconds elapsed since a WinRT `DateTime` (100ns ticks from 1601-01-01 UTC).
/// Used to extrapolate the real playback position, since SMTC rarely refreshes
/// `Position` on its own between state changes.
fn secs_since(dt: DateTime) -> f64 {
    const TICKS_PER_SEC: f64 = 10_000_000.0;
    const EPOCH_DIFF_SECS: f64 = 11_644_473_600.0; // 1601-01-01 -> 1970-01-01
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let now_ticks = (now_unix + EPOCH_DIFF_SECS) * TICKS_PER_SEC;
    (now_ticks - dt.UniversalTime as f64) / TICKS_PER_SEC
}

fn current_session() -> Result<Session> {
    ensure_com();
    let manager = Smtc::RequestAsync()?.get()?;
    manager.GetCurrentSession()
}

/// Read the current track metadata. Returns the default ("nothing playing")
/// snapshot when there is no active session.
pub fn now_playing() -> Result<NowPlaying> {
    let session = current_session()?;
    let props: MediaProps = session.TryGetMediaPropertiesAsync()?.get()?;

    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();

    let is_playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|status| status == PlaybackStatus::Playing)
        .unwrap_or(false);

    let (position_secs, duration_secs) = match session.GetTimelineProperties() {
        Ok(tl) => {
            let start = tl.StartTime().map(ts_to_secs).unwrap_or(0.0);
            let end = tl.EndTime().map(ts_to_secs).unwrap_or(0.0);
            let duration = (end - start).max(0.0);
            let mut position = (tl.Position().map(ts_to_secs).unwrap_or(0.0) - start).max(0.0);

            // SMTC casi nunca refresca Position cada segundo (sobre todo
            // navegadores): se queda "congelada". Extrapolamos con
            // LastUpdatedTime mientras está reproduciendo.
            if is_playing {
                if let Ok(last_updated) = tl.LastUpdatedTime() {
                    let elapsed = secs_since(last_updated);
                    if elapsed > 0.0 && elapsed < 86_400.0 {
                        position += elapsed;
                    }
                }
            }

            if duration > 0.0 {
                position = position.min(duration);
            }
            (position, duration)
        }
        Err(_) => (0.0, 0.0),
    };

    Ok(NowPlaying {
        has_session: true,
        title,
        artist,
        album,
        is_playing,
        position_secs,
        duration_secs,
    })
}

/// Fetch the album art of the current track as a base64 `data:` URL.
/// Called on demand (only when the widget is expanded).
pub fn art() -> Result<String> {
    let session = current_session()?;
    let props: MediaProps = session.TryGetMediaPropertiesAsync()?.get()?;
    read_thumbnail(&props)
}

/// Decode the album art thumbnail into a base64 `data:` URL.
fn read_thumbnail(props: &MediaProps) -> Result<String> {
    let reference: IRandomAccessStreamReference = props.Thumbnail()?;
    let stream = reference.OpenReadAsync()?.get()?;
    let size = stream.Size()?;
    if size == 0 {
        return Err(Error::empty());
    }

    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size as u32)?.get()?;
    let mut buffer = vec![0u8; size as usize];
    reader.ReadBytes(&mut buffer)?;

    let mime = stream
        .ContentType()
        .map(|h| h.to_string())
        .unwrap_or_else(|_| "image/png".into());
    let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn with_session<F>(action: F) -> Result<()>
where
    F: FnOnce(&Session) -> Result<()>,
{
    let session = current_session()?;
    action(&session)
}

pub fn play_pause() -> Result<()> {
    with_session(|s| {
        s.TryTogglePlayPauseAsync()?.get()?;
        Ok(())
    })
}

pub fn next() -> Result<()> {
    with_session(|s| {
        s.TrySkipNextAsync()?.get()?;
        Ok(())
    })
}

pub fn prev() -> Result<()> {
    with_session(|s| {
        s.TrySkipPreviousAsync()?.get()?;
        Ok(())
    })
}

/// Seek to an absolute position (in seconds). Not all players support this.
pub fn seek(position_secs: f64) -> Result<()> {
    with_session(|s| {
        let ticks = (position_secs.max(0.0) * 10_000_000.0) as i64;
        s.TryChangePlaybackPositionAsync(ticks)?.get()?;
        Ok(())
    })
}
