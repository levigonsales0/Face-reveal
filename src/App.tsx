import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase';

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
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}

function safeFileExtension(file: File) {
  const fromName = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fromType = file.type.split('/').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ext = fromName || fromType || 'jpg';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
}

export default function App() {
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

  const loadSignedImages = useCallback(async (paths: string[]) => {
    const nextKey = paths.join('|');
    if (!paths.length) {
      signedKeyRef.current = '';
      setSignedImages([]);
      return;
    }

    if (signedKeyRef.current === nextKey && signedImages.length > 0) return;

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrls(paths, 60 * 10);

    if (error) throw error;

    signedKeyRef.current = nextKey;
    setSignedImages(
      (data ?? [])
        .filter((item): item is { path: string; signedUrl: string } => Boolean(item.signedUrl && item.path))
        .map((item) => ({ path: item.path, url: item.signedUrl })),
    );
  }, [signedImages.length]);

  const loadRoom = useCallback(async (nextRoomId = roomId) => {
    if (!nextRoomId) return;

    const { data, error } = await supabase.rpc('get_face_reveal_room_state', {
      p_room_id: nextRoomId,
    });

    if (error) throw error;

    const normalized = normalizeRoomState(data);
    setRoomState(normalized);

    if (normalized.isRevealed) {
      await loadSignedImages(normalized.imagePaths);
    } else {
      signedKeyRef.current = '';
      setSignedImages([]);
    }
  }, [loadSignedImages, roomId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) setJoinCodeInput(code.toUpperCase());
  }, []);

  useEffect(() => {
    let alive = true;

    async function ensureAnonymousSession() {
      try {
        const sessionResult = await supabase.auth.getSession();
        const sessionUser = sessionResult.data.session?.user;

        if (sessionUser) {
          if (!alive) return;
          setUserId(sessionUser.id);
          setAuthReady(true);
          return;
        }

        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) throw error;

        if (!alive) return;
        setUserId(data.user?.id ?? null);
        setAuthReady(true);
      } catch (error) {
        if (!alive) return;
        setErrorMessage(
          `${getFriendlyError(error)} Make sure Anonymous sign-ins are enabled in Supabase Auth.`,
        );
        setAuthReady(true);
      }
    }

    ensureAnonymousSession();

    return () => {
      alive = false;
    };
  }, []);

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
      const { data, error } = await supabase.rpc('join_face_reveal_room', {
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
  }, [loadRoom]);

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
      const { data, error } = await supabase.rpc('create_face_reveal_room');
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
      setErrorMessage('The image must be 5MB or smaller.');
      return;
    }

    setIsUploading(true);
    setErrorMessage('');
    setNotice('');

    try {
      const ext = safeFileExtension(file);
      const path = `${roomId}/${userId}/${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(path, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false,
      });

      if (uploadError) throw uploadError;

      const { error: completeError } = await supabase.rpc('complete_face_upload', {
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
    await navigator.clipboard.writeText(shareUrl);
    setNotice('Link copied. Send it to the other person.');
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

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="eyebrow">private mutual reveal</div>
        <h1>Both upload. Both reveal.</h1>
        <p className="hero-copy">
          A tiny room where nobody sees the other image until both people have locked one in.
        </p>

        {!authReady && <div className="soft-alert">Preparing anonymous session...</div>}
        {errorMessage && <div className="error-alert">{errorMessage}</div>}
        {notice && <div className="success-alert">{notice}</div>}

        {!roomState && (
          <div className="start-grid">
            <button className="primary-button" disabled={!authReady || isCreating} onClick={createRoom}>
              {isCreating ? 'Creating...' : 'Create reveal room'}
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

        {roomState && (
          <div className="room-panel">
            <div className="room-topbar">
              <div>
                <span className="muted-label">Room code</span>
                <strong>{roomState.joinCode}</strong>
              </div>
              <button className="ghost-button" onClick={resetLocalRoom}>Leave</button>
            </div>

            <div className="share-box">
              <span>{shareUrl}</span>
              <button onClick={copyShareLink}>Copy link</button>
            </div>

            <div className="status-grid">
              <StatusCard title="You" uploaded={Boolean(me?.uploaded)} active />
              <StatusCard title="Other person" uploaded={Boolean(other?.uploaded)} />
            </div>

            <div className={`reveal-state ${roomState.isRevealed ? 'revealed' : ''}`}>
              {roomState.status === 'expired'
                ? 'This room has expired.'
                : roomState.isRevealed
                  ? 'Unlocked. Both images were uploaded.'
                  : roomState.bothJoined
                    ? 'Waiting for both uploads.'
                    : 'Waiting for the other person to join.'}
            </div>

            {!roomState.isRevealed && roomState.status !== 'expired' && !roomState.myUploaded && (
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
                <span>{isUploading ? 'Locking image...' : 'Drop an image or click to upload'}</span>
                <small>Max 5MB. Private until both people upload.</small>
              </label>
            )}

            {!roomState.isRevealed && roomState.myUploaded && (
              <div className="locked-box">
                Your image is locked. Now the other person has to upload.
              </div>
            )}

            {roomState.isRevealed && (
              <div className="images-grid">
                {signedImages.map((image, index) => (
                  <figure key={image.path}>
                    <img src={image.url} alt={`Reveal ${index + 1}`} />
                    <figcaption>{index === 0 ? 'Reveal image' : 'Reveal image'}</figcaption>
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
      </section>

      <section className="rules-card">
        <h2>Rules</h2>
        <p>
          Use this only for normal, consensual images. Do not upload intimate images, private photos of
          someone else, harassment content, or anything you would not want stored even temporarily.
        </p>
      </section>
    </main>
  );
}

function StatusCard({ title, uploaded, active = false }: { title: string; uploaded: boolean; active?: boolean }) {
  return (
    <div className={`status-card ${active ? 'active' : ''}`}>
      <div className="status-dot" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{uploaded ? 'Image locked' : 'Pending'}</p>
    </div>
  );
}
