import { useEffect, useRef, useState, useCallback } from 'react';

interface BrowserViewProps {
  platform: string;
  onComplete: () => void;
  onError: (error: string) => void;
}

export default function BrowserView({ platform, onComplete, onError }: BrowserViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'complete' | 'error'>('connecting');

  const sendEvent = useCallback((event: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...event, platform }));
    }
  }, [platform]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start_login', platform }));
      setStatus('streaming');
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'frame' && msg.platform === platform) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const img = new Image();
        img.onload = () => {
          canvas.width = msg.width || 1280;
          canvas.height = msg.height || 720;
          ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${msg.data}`;
      }

      if (msg.type === 'login_complete' && msg.platform === platform) {
        setStatus('complete');
        onComplete();
      }

      if (msg.type === 'login_failed' && msg.platform === platform) {
        setStatus('error');
        onError(msg.reason || 'Login failed');
      }
    };

    ws.onerror = () => {
      setStatus('error');
      onError('WebSocket connection failed');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_login', platform }));
      }
      ws.close();
    };
  }, [platform, onComplete, onError]);

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    sendEvent({ type: 'mouse_click', x, y });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const specialKeys = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End'];
    if (specialKeys.includes(e.key)) {
      sendEvent({ type: 'key_press', key: e.key });
    } else if (e.key.length === 1) {
      sendEvent({ type: 'key_type', text: e.key });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    sendEvent({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY });
  };

  return (
    <div className="flex flex-col items-center gap-4">
      {status === 'connecting' && (
        <div className="text-gray-500 text-sm">Connecting to browser...</div>
      )}
      {status === 'complete' && (
        <div className="text-green-600 font-medium">Login successful!</div>
      )}
      {status === 'error' && (
        <div className="text-red-600 font-medium">Connection error. Try again.</div>
      )}
      <div className="border border-gray-300 rounded-lg overflow-hidden shadow-lg bg-white">
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          tabIndex={0}
          className="w-full max-w-4xl cursor-pointer outline-none"
          style={{ aspectRatio: '16/9' }}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
        />
      </div>
      <p className="text-xs text-gray-400">
        Click inside the browser view to interact. Complete the login flow, then confirm on your phone.
      </p>
    </div>
  );
}
