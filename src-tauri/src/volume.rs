//! System volume bridge built on the Windows Core Audio API. On Windows the
//! volume lives in a different subsystem than the media session, so it gets its
//! own module. This controls the master volume of the default render endpoint.

use windows::core::Result;
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

#[derive(serde::Serialize)]
pub struct VolumeState {
    /// Master volume in the `0.0..=1.0` range.
    pub level: f32,
    pub muted: bool,
}

fn ensure_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Resolve the volume interface for the default audio render endpoint.
fn endpoint() -> Result<IAudioEndpointVolume> {
    ensure_com();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        Ok(endpoint)
    }
}

pub fn get_volume() -> Result<VolumeState> {
    let endpoint = endpoint()?;
    unsafe {
        Ok(VolumeState {
            level: endpoint.GetMasterVolumeLevelScalar()?,
            muted: endpoint.GetMute()?.as_bool(),
        })
    }
}

pub fn set_volume(level: f32) -> Result<()> {
    let endpoint = endpoint()?;
    let clamped = level.clamp(0.0, 1.0);
    unsafe { endpoint.SetMasterVolumeLevelScalar(clamped, std::ptr::null())? };
    Ok(())
}

pub fn toggle_mute() -> Result<()> {
    let endpoint = endpoint()?;
    unsafe {
        let muted = endpoint.GetMute()?.as_bool();
        endpoint.SetMute(BOOL::from(!muted), std::ptr::null())?;
    }
    Ok(())
}
