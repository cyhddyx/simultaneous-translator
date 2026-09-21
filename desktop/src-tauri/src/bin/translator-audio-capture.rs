use std::{
    collections::VecDeque,
    error::Error,
    io::{self, Read, Write},
    thread,
    time::{Duration, Instant},
};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

fn capture(process_id: u32) -> Result<(), Box<dyn Error>> {
    initialize_mta().ok()?;
    // False maps to EXCLUDE_TARGET_PROCESS_TREE in wasapi. Both translated
    // voices are rendered by this Python process and must be excluded together.
    let mut client = AudioClient::new_application_loopback_client(process_id, false)?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 200_000,
        },
    )?;
    let event = client.set_get_eventhandle()?;
    let reader = client.get_audiocaptureclient()?;
    client.start_stream()?;
    let mut output = io::stdout().lock();
    output.write_all(b"STC1")?;
    output.flush()?;
    let mut pending = VecDeque::new();
    let mut last_write = Instant::now();
    let mut block = [0u8; 4800 * 2 * 4];
    loop {
        let _ = event.wait_for_event(20);
        while reader.get_next_packet_size()?.unwrap_or(0) > 0 {
            reader.read_from_device_to_deque(&mut pending)?;
        }
        // Bound latency if the parent was briefly busy.
        while pending.len() > block.len() * 3 {
            pending.drain(..block.len());
        }
        if pending.len() >= block.len() || last_write.elapsed() >= Duration::from_millis(100) {
            for byte in &mut block {
                *byte = pending.pop_front().unwrap_or(0);
            }
            output.write_all(&block)?;
            output.flush()?;
            last_write = Instant::now();
        }
    }
}

fn main() {
    // The control pipe also terminates a stalled activation after parent exit.
    thread::spawn(|| {
        let _ = io::stdin().read(&mut [0u8]);
        std::process::exit(0);
    });
    let result = std::env::args()
        .nth(1)
        .ok_or("missing excluded process id".into())
        .and_then(|value| {
            value
                .parse::<u32>()
                .map_err(|error| Box::new(error) as Box<dyn Error>)
        })
        .and_then(capture);
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
