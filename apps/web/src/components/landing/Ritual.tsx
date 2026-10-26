'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';

const STAGES = [
  { name: 'Scan', clause: 'Scan the code on each device.', body: 'Phones, laptops and tablets join from the camera. No app, no account.' },
  { name: 'Place', clause: 'Tap where each one sits.', body: 'Pick stereo or surround for the speakers you have and tap each one into its spot.' },
  { name: 'Tune', clause: 'Tune once from your seat.', body: 'One chime per speaker, heard from where you sit, lines up their timing and matches their loudness, Bluetooth included.' },
  { name: 'Play', clause: 'Press play. Hear one sound.', body: 'Every device starts at the same instant and stays locked while it plays.' },
];

/** sample devices for the fragments (illustrative values, not measurements) */
const TUNED = [
  { name: 'Laptop', kind: 'Front left', delay: '+12 ms', level: '−1.0 dB' },
  { name: 'Kitchen speaker', kind: 'Front right · Bluetooth', delay: '+184 ms', level: '−2.5 dB' },
  { name: 'Tablet', kind: 'Centre', delay: '+31 ms', level: '+1.5 dB' },
];

function Fragment({ stage, qr }: { stage: number; qr: string | null }) {
  if (stage === 0)
    return (
      <div className="frag frag-scan" data-ui>
        {qr ? <img src={qr} alt="QR code that opens SyncSound" width={220} height={220} /> : <span className="frag-qr-blank" />}
        <p className="frag-title">Living room</p>
        <p className="frag-note">Scan with each device&rsquo;s camera to join</p>
      </div>
    );
  if (stage === 1)
    return (
      <div className="frag frag-place" data-ui>
        <p className="frag-title">Where is the kitchen speaker?</p>
        <div className="frag-slots">
          {['Front left', 'Centre', 'Front right'].map((s) => (
            <span key={s} className={s === 'Front right' ? 'is-on' : ''}>
              {s}
            </span>
          ))}
        </div>
        <p className="frag-note">Tap its spot in the room</p>
      </div>
    );
  if (stage === 2)
    return (
      <div className="frag frag-tune" data-ui>
        <p className="frag-title">Tuned from your seat</p>
        <table>
          <tbody>
            {TUNED.map((d) => (
              <tr key={d.name}>
                <th scope="row">
                  {d.name}
                  <span>{d.kind}</span>
                </th>
                <td className="tabular">{d.delay}</td>
                <td className="tabular">{d.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="frag frag-play" data-ui>
      <p className="frag-title">Now playing in the living room</p>
      <p className="frag-note">3 speakers, in sync</p>
      <div className="frag-bar" aria-hidden>
        <span />
      </div>
      <div className="frag-transport" aria-hidden>
        <span className="frag-play-btn" />
        <span className="tabular">1:24 / 3:51</span>
      </div>
    </div>
  );
}

/** Scan → Place → Tune → Play, driven by one real range input (arrow keys work); nothing depends on scroll. */
export function Ritual() {
  const [stage, setStage] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(location.origin, { margin: 1, width: 440, color: { dark: '#0e0c0a', light: '#eeeae3' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, []);
  const s = STAGES[stage]!;
  return (
    <div className="ritual">
      <div className="ritual-clause">
        <h2 id="how-h" className="ritual-h" aria-live="polite" key={stage}>
          <span className="sr-only">How it works: </span>
          {s.clause}
        </h2>
        <p className="lead">{s.body}</p>
      </div>
      <div className="ritual-stage" key={`f${stage}`}>
        <Fragment stage={stage} qr={qr} />
      </div>
      <div className="ritual-track" style={{ '--p': stage / (STAGES.length - 1) } as CSSProperties}>
        <label htmlFor="ritual-range" className="sr-only">
          Setup step
        </label>
        <input
          id="ritual-range"
          type="range"
          min={0}
          max={STAGES.length - 1}
          step={1}
          value={stage}
          onChange={(e) => setStage(Number(e.target.value))}
          aria-valuetext={`${s.name}: ${s.clause}`}
        />
        <ol className="ritual-names">
          {STAGES.map((st, i) => (
            <li key={st.name}>
              <button type="button" aria-current={i === stage ? 'step' : undefined} onClick={() => setStage(i)}>
                {st.name}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
