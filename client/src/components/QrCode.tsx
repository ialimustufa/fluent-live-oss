import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QrCode({ url, size = 180 }: { url: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    void QRCode.toDataURL(url, {
      width: size * 2,
      margin: 1,
      color: { dark: '#0a0a0f', light: '#ffffff' },
    }).then(setDataUrl);
  }, [url, size]);

  return (
    <div
      className="grad-border rounded-2xl p-1 shadow-lg"
      style={{ width: size + 32, height: size + 32 }}
    >
      <div className="rounded-xl bg-white p-3">
        {dataUrl ? (
          <img src={dataUrl} alt={`QR code for ${url}`} width={size} height={size} className="rounded-lg" />
        ) : (
          <div style={{ width: size, height: size }} className="animate-pulse rounded-lg bg-slate-200" />
        )}
      </div>
    </div>
  );
}
