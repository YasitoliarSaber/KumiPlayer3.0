import { RadioGroup } from 'radix-ui';
import { Check } from 'lucide-react';
import { MATERIAL_LABELS, type FontPreset } from '@/app/theme';
import { updateDemoState, useDemoState } from '@/mock/demo-store';
import { SegmentedControl } from '@/shared/ui/segmented';
import panel from './SettingsPage.module.css';
import styles from './MaterialPreferences.module.css';
import wenkaiLicense from '../../../../resources/fonts/LXGW-WenKai-OFL.txt?url';
import webfontLicense from '../../../../resources/fonts/LXGW-webfont-MIT.txt?url';
import manropeLicense from '../../../../resources/fonts/Manrope-OFL.txt?url';
import glassLicense from '../../../../resources/fonts/quick-liquid-MIT.txt?url';

const hints = {
  solid: '干净、轻量的纯色表面',
  mica: '柔和、静止的云母底纹',
  acrylic: '通透的磨砂与柔光',
  liquid: '清透玻璃与局部折射',
} as const;
const fonts: ReadonlyArray<{ value: FontPreset; label: string }> = [
  { value: 'system', label: '系统字体' },
  { value: 'modern', label: '现代无衬线' },
  { value: 'wenkai', label: '霞鹜文楷' },
];

export function MaterialPreferences() {
  const appearance = useDemoState().settings.appearance;
  const patch = (value: Partial<typeof appearance>) => updateDemoState((current) => ({
    settings: { ...current.settings, appearance: { ...current.settings.appearance, ...value } },
  }));
  return (
    <>
      <section className={panel.panel} aria-labelledby="material-heading">
        <h2 className={panel.panelTitle} id="material-heading">界面材质</h2>
        <p className={panel.panelHint}>选择窗口背景与浮层的质感。海报保持清晰、轻量。</p>
        <RadioGroup.Root
          value={appearance.material ?? 'mica'}
          onValueChange={(value) => {
            const material = MATERIAL_LABELS.find((option) => option.value === value)?.value;
            if (material) patch({ material });
          }}
          aria-label="界面材质"
          className={styles.materials}
        >
          {MATERIAL_LABELS.map((option) => (
            <RadioGroup.Item key={option.value} value={option.value} className={styles.choice} aria-label={option.label}>
              <span className={styles.preview} data-preview={option.value} aria-hidden="true">
                <span className={styles.previewSidebar} />
                <span className={styles.previewWindow}><i /><i /><i /></span>
              </span>
              <span className={styles.choiceLabel}>{option.label}<RadioGroup.Indicator><Check size={14} /></RadioGroup.Indicator></span>
              <span className={styles.hint}>{hints[option.value]}</span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        <p className={styles.note}>云母为浏览器模拟效果；系统要求减少透明度时自动使用纯色。液态玻璃仅在搜索等小面积表面使用折射。</p>
      </section>
      <section className={panel.panel} aria-labelledby="font-heading">
        <h2 className={panel.panelTitle} id="font-heading">字体</h2>
        <SegmentedControl ariaLabel="界面字体" value={appearance.font ?? 'system'} options={fonts} onValueChange={(font) => patch({ font })} className={styles.fontOptions} />
        <div className={styles.fontPreview}>
          <strong>留一点时间，给喜欢的故事。</strong>
          <span>继续观看 · 番剧与电影 · KumiPlayer 2026</span>
        </div>
        <p className={styles.note}>系统字体保持熟悉的阅读感；现代无衬线以 Manrope 搭配系统中文；文楷使用屏幕阅读版。字体随应用提供，无需联网。</p>
        <p className={styles.licenses}>开源许可：{[
          ['霞鹜文楷', wenkaiLicense], ['Web 字体封装', webfontLicense], ['Manrope', manropeLicense], ['Quick Liquid', glassLicense],
        ].map(([label, href]) => <a key={label} href={href} target="_blank" rel="noreferrer">{label}</a>)}</p>
      </section>
    </>
  );
}
