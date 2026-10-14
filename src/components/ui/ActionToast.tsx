import { useEffect, useId, type ReactNode } from 'react';
import { create } from 'zustand';
import { createPortal } from 'react-dom';
import { Button, FluentProvider, MessageBar, MessageBarActions, MessageBarBody } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { useUiStore } from '../../stores/ui';
import { getKumiFluentTheme } from '../../design/fluentTheme';
import '../../styles/action-toast.css';

const useActiveToast = create<{ owner: string }>(() => ({ owner: '' }));

/** 短操作反馈浮在窗口上，不挤动表单或长任务列表。 */
export default function ActionToast({ message, intent = 'info', onDismiss, action }: {
  message: string;
  intent?: 'info' | 'success' | 'error';
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  const appearance = useUiStore(state => state.appearanceMode);
  const owner = useId();
  const activeOwner = useActiveToast(state => state.owner);
  const dismiss = () => {
    if (useActiveToast.getState().owner === owner) useActiveToast.setState({ owner: '' });
    onDismiss?.();
  };
  useEffect(() => {
    if (message) useActiveToast.setState({ owner });
    return () => { if (useActiveToast.getState().owner === owner) useActiveToast.setState({ owner: '' }); };
  }, [message, owner]);
  if (!message || activeOwner !== owner) return null;
  return createPortal(<FluentProvider theme={getKumiFluentTheme(appearance)} className="kp-action-toast">
    <MessageBar intent={intent} layout="multiline" role={intent === 'error' ? 'alert' : 'status'}>
      <MessageBarBody>{message}</MessageBarBody>
      <MessageBarActions containerAction={<Button appearance="transparent" icon={<Dismiss16Regular />} aria-label="关闭提示" onClick={dismiss} />}>{action}</MessageBarActions>
    </MessageBar>
  </FluentProvider>, document.body);
}
