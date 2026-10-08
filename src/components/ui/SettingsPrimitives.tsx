import { useId, type ReactNode } from 'react';
import { Field, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import '../../styles/settings-primitives.css';

/** 设置页的共享组合：业务仍由调用方保存，展示层只负责结构与无障碍。 */
export function SettingsSection({ title, headingId, description, children }: {
  title: string;
  headingId?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const titleId = headingId || generatedId;
  return <section className="kp-settings-section" aria-labelledby={titleId}>
    <header className="kp-settings-section-heading">
      <h3 id={titleId}>{title}</h3>
      {description && <p className="kp-settings-description">{description}</p>}
    </header>
    {children}
  </section>;
}

/** Field 上下文把标签与帮助文字关联到内部单个 Fluent 控件。 */
export function SettingsField({ label, description, action, orientation, children }: {
  label: string;
  description?: ReactNode;
  action?: ReactNode;
  orientation?: 'horizontal' | 'vertical';
  children: ReactNode;
}) {
  return <Field className="kp-settings-field" orientation={orientation} label={label} hint={description === undefined ? undefined : { children: description }}>
    <div className={`kp-settings-field-controls${action ? ' kp-settings-field-controls--action' : ''}`}>
      {children}
      {action && <span className="kp-settings-field-action">{action}</span>}
    </div>
  </Field>;
}

export function SettingsFeedback({ intent = 'info', busy = false, children }: {
  intent?: 'info' | 'success' | 'error';
  busy?: boolean;
  children: ReactNode;
}) {
  return <MessageBar className="kp-settings-feedback" intent={intent} layout="multiline"
    role={intent === 'error' ? 'alert' : 'status'} aria-live={intent === 'error' ? 'assertive' : 'polite'}
    icon={busy ? <Spinner size="tiny" aria-hidden="true" /> : undefined}>
    <MessageBarBody>{children}</MessageBarBody>
  </MessageBar>;
}
