import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { defaultImageLifecycle } from '../library/posterImageLifecycle';

export type ImageState = 'loading' | 'ready' | 'error';
type DecodedImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  onDecoded?: (image: HTMLImageElement) => void;
  onStateChange?: (state: ImageState) => void;
  revealOnLoad?: boolean;
};

export default function DecodedImage({ className = '', decoding = 'async', onDecoded, onStateChange,
  revealOnLoad: _revealOnLoad, onError, onLoad, src, ...props }: DecodedImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const callbacks = useRef({ onDecoded, onStateChange, onError, onLoad });
  callbacks.current = { onDecoded, onStateChange, onError, onLoad };
  const [state, setState] = useState<ImageState>(src ? 'loading' : 'error');
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    setState(src ? 'loading' : 'error');
    if (!src) return;
    const root = image.closest<HTMLElement>('.app-main');
    defaultImageLifecycle.configure(root, root?.clientHeight || window.innerHeight);
    return defaultImageLifecycle.register(image, { url: src, onState: (next) => {
      if (next === 'idle') return;
      setState(next);
      callbacks.current.onStateChange?.(next);
      // load 是浏览器完整资源终态；无需额外 decode 批次才能显示。
      if (next === 'ready') callbacks.current.onDecoded?.(image);
    } });
  }, [src]);
  return <img {...props} ref={imageRef} loading="eager" decoding={decoding} data-image-state={state}
    className={`decoded-image ${state === 'ready' ? 'is-ready' : 'is-pending'} ${className}`.trim()}
    onLoad={(event) => callbacks.current.onLoad?.(event)}
    onError={(event) => callbacks.current.onError?.(event)} />;
}
