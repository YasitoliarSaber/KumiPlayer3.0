import { useEffect, useState } from 'react';
import { useDemoState } from '@/mock/demo-store';

export function AppearanceController() {
  const font = useDemoState().settings.appearance.font ?? 'system';
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.font = font;
    setFailed(false);
    let active = true;
    // Manrope 与品牌共用小字库；较大的中文字库只在选中后请求。
    if (font === 'wenkai') void import('lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css')
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [font]);
  useEffect(() => {
    document.documentElement.dataset.fontFallback = failed ? 'true' : 'false';
  }, [failed]);
  return null;
}
