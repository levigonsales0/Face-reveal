import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasSupabaseConfig, supabase } from './lib/supabase';

const BUCKET_NAME = 'face-reveals';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const POLL_MS = 2500;

type RoomStatus = 'open' | 'revealed' | 'expired';
type Slot = 'a' | 'b';

type ParticipantState = {
  slot: Slot;
  uploaded: boolean;
  isMe: boolean;
};

type RoomState = {
  roomId: string;
  joinCode: string;
  status: RoomStatus;
  mySlot: Slot;
  myUploaded: boolean;
  bothJoined: boolean;
  isRevealed: boolean;
  revealedAt: string | null;
  expiresAt: string;
  participants: ParticipantState[];
  imagePaths: string[];
};

type SignedImage = {
  path: string;
  url: string;
};

function normalizeRoomState(raw: unknown): RoomState {
  const data = raw as Record<string, unknown>;

  return {
    roomId: String(data.roomId ?? data.room_id ?? ''),
    joinCode: String(data.joinCode ?? data.join_code ?? ''),
    status: String(data.status ?? 'open') as RoomStatus,
    mySlot: String(data.mySlot ?? data.my_slot ?? 'a') as Slot,
    myUploaded: Boolean(data.myUploaded ?? data.my_uploaded),
    bothJoined: Boolean(data.bothJoined ?? data.both_joined),
    isRevealed: Boolean(data.isRevealed ?? data.is_revealed),
    revealedAt: data.revealedAt || data.revealed_at ? String(data.revealedAt ?? data.revealed_at) : null,
    expiresAt: String(data.expiresAt ?? data.expires_at ?? ''),
    participants: Array.isArray(data.participants) ? (data.participants as ParticipantState[]) : [],
    imagePaths: Array.isArray(data.imagePaths ?? data.image_paths)
      ? ((data.imagePaths ?? data.image_paths) as string[])
      : [],
  };
}

function getFriendlyError(error: unknown) {
  console.error('FACE_REVEAL_ERROR:', error);

  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (error && typeof error === 'object') {
    const err = error as {
      message?: string;
      details?: string;
      hint?: string;
      code?: string;
      error_description?: string;
      statusText?: string;
    };

    return [
      err.message || err.error_description || err.statusText || 'Something went wrong.',
      err.details,
      err.hint,
      err.code ? `Code: ${err.code}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return 'Something went wrong.';
}

function safeFileExtension(file: File) {
  const fromName = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fromType = file.type.split('/').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ext = fromName || fromType || 'jpg';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getRoomProgress(roomState: RoomState | null) {
  if (!roomState) return 0;
  const joined = roomState.participants.length;
  const uploaded = roomState.participants.filter((participant) => participant.uploaded).length;
  if (roomState.isRevealed) return 100;
  return Math.min(100, joined * 25 + uploaded * 25);
}

function getStateCopy(roomState: RoomState) {
  if (roomState.status === 'expired') {
    return {
      label: 'Expired',
      title: 'This room expired.',
      body: 'Create a fresh room and send the new link.',
    };
  }

  if (roomState.isRevealed) {
    return {
      label: 'Unlocked',
      title: 'Both images are revealed.',
      body: 'Both people uploaded, so the reveal opened at the same time.',
    };
  }

  if (!roomState.bothJoined) {
    return {
      label: 'Waiting',
      title: 'Send the link to the other person.',
      body: 'The room stays locked until a second person joins and uploads.',
    };
  }

  if (roomState.myUploaded) {
    return {
      label: 'Locked',
      title: 'Your image is locked in.',
      body: 'Now wait for the other person. They still cannot see your image.',
    };
  }

  return {
    label: 'Ready',
    title: 'Both are inside. Upload yours.',
    body: 'After the second image is locked, the reveal opens for both people.',
  };
}

export default function App() {
  if (!hasSupabaseConfig || !supabase) return <MissingSupabaseConfig />;
  return <RevealApp />;
}

function MissingSupabaseConfig() {
  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="hero-layout">
        <div className="hero-copy-block">
          <div className="eyebrow">Vercel setup needed</div>
          <h1>Missing Supabase env.</h1>
          <p className="hero-copy">
            The app loaded, but Vercel does not have the Supabase variables yet. Add them, redeploy, and the reveal room will start working.
          </p>
          <div className="trust-strip">
            <MiniStat value="01" label="Vercel settings" />
            <MiniStat value="02" label="Environment variables" />
            <MiniStat value="03" label="Redeploy" />
          </div>
        </div>
        <div className="control-card">
          <div className="start-panel">
            <div>
              <p className="panel-kicker">Required variables</p>
              <h2>Add these in Vercel.</h2>
              <p>Project → Settings → Environment Variables</p>
            </div>
            <div className="join-box">
              <label>Variables</label>
              <p><strong>VITE_SUPABASE_URL</strong></p>
              <p><strong>VITE_SUPABASE_ANON_KEY</strong></p>
            </div>
            <div className="locked-box">
              <span aria-hidden="true">●</span>
              Do not use the service_role key. Use the anon public key only.
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function RevealApp() {
  const client = supabase!;
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [signedImages, setSignedImages] = useState<SignedImage[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const autoJoinTried = useRef(false);
  const signedKeyRef = useRef('');

  const shareUrl = useMemo(() => {
    if (!roomState?.joinCode) return '';
    const url = new URL(window.location.href);
    url.searchParams.set('code', roomState.joinCode);
    return url.toString();
  }, [roomState?.joinCode]);

  const expiresLabel = useMemo(() => {
    if (!roomState?.expiresAt) return '';
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(new Date(roomState.expiresAt));
  }, [roomState?.expiresAt]);

  const progress = useMemo(() => getRoomProgress(roomState), [roomState]);
  const stateCopy = roomState ? getStateCopy(roomState) : null;

  const loadSignedImages = useCallback(async (paths: string[]) => {
    const nextKey = paths.join('|');
    if (!paths.length) {
      signedKeyRef.current = '';
      setSignedImages([]);
      return;
    }

    if (signedKeyRef.current === nextKey && signedImages.length > 0) return;

    const { data, error } = await client.storage
      .from(BUCKET_NAME)
      .createSignedUrls(paths, 60 * 10);

    if (error) throw error;

    signedKeyRef.current = nextKey;
    setSignedImages(
      (data ?? [])
        .filter((item) => Boolean(item.signedUrl && item.path))
        .map((item) => ({ path: String(item.path), url: String(item.signedUrl) })),
    );
  }, [client, signedImages.length]);

  const loadRoom = useCallback(async (nextRoomId = roomId) => {
    if (!nextRoomId) return;

    const { data, error } = await client.rpc('get_face_reveal_room_state', {
      p_room_id: nextRoomId,
    });

    if (error) throw error;

    const normalized = normalizeRoomState(data);
    setRoomState(normalized);

    if (normalized.isRevealed) await loadSignedImages(normalized.imagePaths);
    else {
      signedKeyRef.current = '';
      setSignedImages([]);
    }
  }, [client, loadSignedImages, roomId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) setJoinCodeInput(code.toUpperCase());
  }, []);

  useEffect(() => {
    let alive = true;

    async function ensureAnonymousSession() {
      try {
        const sessionResult = await client.auth.getSession();
        const sessionUser = sessionResult.data.session?.user;

        if (sessionUser) {
          if (!alive) return;
          setUserId(sessionUser.id);
          setAuthReady(true);
          return;
        }

        const { data, error } = await client.auth.signInAnonymously();
        if (error) throw error;

        if (!alive) return;
        setUserId(data.user?.id ?? null);
        setAuthReady(true);
      } catch (error) {
        if (!alive) return;
        setErrorMessage(`${getFriendlyError(error)} Make sure Anonymous sign-ins are enabled in Supabase Auth.`);
        setAuthReady(true);
      }
    }

    ensureAnonymousSession();

    return () => {
      alive = false;
    };
  }, [client]);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;

    async function tick() {
      try {
        if (!cancelled) await loadRoom(roomId);
      } catch (error) {
        if (!cancelled) setErrorMessage(getFriendlyError(error));
      }
    }

    tick();
    const interval = window.setInterval(tick, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadRoom, roomId]);

  const joinRoom = useCallback(async (code: string) => {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) {
      setErrorMessage('Put a room code first.');
      return;
    }

    setIsJoining(true);
    setErrorMessage('');
    setNotice('');

    try {
      const { data, error } = await client.rpc('join_face_reveal_room', {
        p_join_code: cleanCode,
      });

      if (error) throw error;

      const nextRoomId = String(data);
      setRoomId(nextRoomId);
      window.history.replaceState(null, '', `?code=${cleanCode}`);
      await loadRoom(nextRoomId);
    } catch (error) {
      setErrorMessage(getFriendlyError(error));
    } finally {
      setIsJoining(false);
    }
  }, [client, loadRoom]);

  useEffect(() => {
    if (!authReady || roomId || autoJoinTried.current || !joinCodeInput) return;
    autoJoinTried.current = true;
    joinRoom(joinCodeInput);
  }, [authReady, joinCodeInput, joinRoom, roomId]);

  async function createRoom() {
    setIsCreating(true);
    setErrorMessage('');
    setNotice('');

    try {
      const { data, error } = await client.rpc('create_face_reveal_room');
      if (error) throw error;

      const created = Array.isArray(data) ? data[0] : data;
      const nextRoomId = String(created.room_id);
      const nextJoinCode = String(created.join_code);

      setRoomId(nextRoomId);
      setJoinCodeInput(nextJoinCode);
      window.history.replaceState(null, '', `?code=${nextJoinCode}`);
      await loadRoom(nextRoomId);
    } catch (error) {
      setErrorMessage(getFriendlyError(error));
    } finally {
      setIsCreating(false);
    }
  }

  async function uploadImage(file: File) {
    if (!roomId || !userId) {
      setErrorMessage('Session is not ready yet.');
      return;
    }

    if (!file.type.startsWith('image/')) {
      setErrorMessage('Upload a valid image file.');
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setErrorMessage(`The image must be 5MB or smaller. This file is ${formatFileSize(file.size)}.`);
      return;
    }

    setIsUploading(true);
    setErrorMessage('');
    setNotice('');

    try {
      const ext = safeFileExtension(file);
      const path = `${roomId}/${userId}/${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await client.storage.from(BUCKET_NAME).upload(path, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false,
      });

      if (uploadError) throw uploadError;

      const { error: completeError } = await client.rpc('complete_face_upload', {
        p_room_id: roomId,
        p_image_path: path,
      });

      if (completeError) throw completeError;

      setNotice('Image locked. It will unlock when both people have uploaded.');
      await loadRoom(roomId);
    } catch (error) {
      setErrorMessage(getFriendlyError(error));
    } finally {
      setIsUploading(false);
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) uploadImage(file);
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) uploadImage(file);
  }

  async function copyShareLink() {
    if (!shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setNotice('Link copied. Send it to the other person.');
    } catch {
      setErrorMessage(`Could not copy automatically. Copy this link manually: ${shareUrl}`);
    }
  }

  function resetLocalRoom() {
    setRoomId(null);
    setRoomState(null);
    setSignedImages([]);
    setNotice('');
    setErrorMessage('');
    signedKeyRef.current = '';
    window.history.replaceState(null, '', window.location.pathname);
  }

  const me = roomState?.participants.find((participant) => participant.isMe);
  const other = roomState?.participants.find((participant) => !participant.isMe);
  const canUpload = roomState && !roomState.isRevealed && roomState.status !== 'expired' && !roomState.myUploaded;

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="Face Reveal home">
          <span className="brand-mark">FR</span>
          <span>
            <strong>Face Reveal</strong>
            <small>Mutual room</small>
          </span>
        </a>

        <div className="topbar-pills" aria-label="Safety notes">
          <span>Private bucket</span>
          <span>2 people</span>
          <span>24h room</span>
        </div>
      </header>

      <section className="hero-layout">
        <div className="hero-copy-block">
          <div className="eyebrow">Private mutual reveal</div>
          <h1>Locked until both upload.</h1>
          <p className="hero-copy">
            A clean reveal room where nobody sees the other image first. Both people lock one in, then both images open at the same time.
          </p>

          <div className="trust-strip">
            <MiniStat value="01" label="Create a room" />
            <MiniStat value="02" label="Share the link" />
            <MiniStat value="03" label="Both reveal" />
          </div>
        </div>

        <div className="control-card">
          {!authReady && <Alert tone="soft" message="Preparing anonymous session..." />}
          {errorMessage && <Alert tone="error" message={errorMessage} />}
          {notice && <Alert tone="success" message={notice} />}

          {!roomState && (
            <div className="start-panel">
              <div>
                <p className="panel-kicker">Start</p>
                <h2>Create a locked room.</h2>
                <p>Send one private link. The reveal only unlocks after both uploads are completed.</p>
              </div>

              <button className="primary-button" disabled={!authReady || isCreating} onClick={createRoom}>
                <span>{isCreating ? 'Creating room...' : 'Create reveal room'}</span>
                <span aria-hidden="true">↗</span>
              </button>

              <div className="join-box">
                <label htmlFor="join-code">Have a code?</label>
                <div className="join-row">
                  <input
                    id="join-code"
                    value={joinCodeInput}
                    onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
                    placeholder="AB12CD34"
                    maxLength={12}
                  />
                  <button disabled={!authReady || isJoining} onClick={() => joinRoom(joinCodeInput)}>
                    {isJoining ? 'Joining...' : 'Join'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {roomState && stateCopy && (
            <div className="room-panel">
              <div className="room-topbar">
                <div>
                  <span className="muted-label">Room code</span>
                  <strong>{roomState.joinCode}</strong>
                </div>
                <button className="ghost-button" onClick={resetLocalRoom}>Leave</button>
              </div>

              <div className="progress-wrap" aria-label="Room progress">
                <div className="progress-meta">
                  <span>{stateCopy.label}</span>
                  <span>{progress}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
              </div>

              <div className={`state-card ${roomState.isRevealed ? 'is-revealed' : ''} ${roomState.status === 'expired' ? 'is-expired' : ''}`}>
                <span>{stateCopy.label}</span>
                <h2>{stateCopy.title}</h2>
                <p>{stateCopy.body}</p>
              </div>

              <div className="share-box">
                <span>{shareUrl}</span>
                <button onClick={copyShareLink}>Copy link</button>
              </div>

              <div className="status-grid">
                <StatusCard title="You" slot={roomState.mySlot.toUpperCase()} uploaded={Boolean(me?.uploaded)} active />
                <StatusCard title="Other person" slot={other?.slot ? other.slot.toUpperCase() : '?'} uploaded={Boolean(other?.uploaded)} />
              </div>

              {canUpload && (
                <label
                  className={`upload-dropzone ${dragActive ? 'drag-active' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <input type="file" accept="image/*" onChange={handleFileInput} disabled={isUploading} />
                  <span className="upload-icon" aria-hidden="true">+</span>
                  <strong>{isUploading ? 'Locking image...' : 'Drop or choose image'}</strong>
                  <small>Max 5MB. Private until both people upload.</small>
                </label>
              )}

              {!roomState.isRevealed && roomState.myUploaded && (
                <div className="locked-box">
                  <span aria-hidden="true">●</span>
                  Your image is locked. The other person still cannot see it.
                </div>
              )}

              {roomState.isRevealed && (
                <div className="images-grid">
                  {signedImages.map((image, index) => (
                    <figure key={image.path}>
                      <img src={image.url} alt={`Reveal ${index + 1}`} />
                      <figcaption>Reveal {index + 1}</figcaption>
                    </figure>
                  ))}
                </div>
              )}

              <div className="room-footer">
                <span>Expires: {expiresLabel || 'soon'}</span>
                <span>{roomState.mySlot === 'a' ? 'Creator slot' : 'Guest slot'}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rules-card">
        <div>
          <p className="panel-kicker">Rules</p>
          <h2>Keep it normal and consensual.</h2>
        </div>
        <p>
          Use this only for normal images you are allowed to share. Do not upload intimate images, harassment, private photos of someone else, or anything you would not want stored even temporarily.
        </p>
      </section>
    </main>
  );
}

function Alert({ tone, message }: { tone: 'soft' | 'error' | 'success'; message: string }) {
  return <div className={`alert ${tone}`}>{message}</div>;
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="mini-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StatusCard({ title, slot, uploaded, active = false }: { title: string; slot: string; uploaded: boolean; active?: boolean }) {
  return (
    <div className={`status-card ${active ? 'active' : ''} ${uploaded ? 'uploaded' : ''}`}>
      <div className="status-card-top">
        <span className="status-dot" aria-hidden="true" />
        <span className="slot-pill">Slot {slot}</span>
      </div>
      <h3>{title}</h3>
      <p>{uploaded ? 'Image locked' : 'Pending upload'}</p>
    </div>
  );
}
