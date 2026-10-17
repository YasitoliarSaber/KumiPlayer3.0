/**
 * SegmentedControl（Radix ToggleGroup 官方原语）。
 *
 * 用于原型里的互斥分段选择（主题 / 材质 / 播放器 / 动效），
 * 单选语义、键盘方向键与 roving tabindex 都由 Radix 提供，
 * 不自己实现第二套焦点逻辑。
 */

import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';

import { cn } from '@/shared/lib/utils';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next as T);
        }
      }}
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12.5px] text-muted-foreground outline-none',
            'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            'data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm',
            'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5',
          )}
        >
          {option.icon}
          <span>{option.label}</span>
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
