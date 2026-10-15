/**
 * 设置页专用的薄表单适配层。
 *
 * 设置表单原先按 Mantine 的入参形状书写（`data` / `onChange(value)` / `min` / `max`）。
 * 这里把它们映射到 shadcn/ui 的 Select、原生数字输入与原生 title 提示；
 * 渲染、键盘与无障碍行为全部由 shadcn 组件和浏览器原生控件承担，不新建控件体系。
 * 仅本目录使用，不进入 shared/ui。
 */

import type { ReactNode } from 'react';

import { Input } from '@/shared/ui/input';
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function Select({
  data,
  value,
  onChange,
  label,
  placeholder,
  disabled,
}: {
  readonly data: readonly SelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}) {
  return (
    <SelectRoot value={value} onValueChange={onChange} disabled={disabled}>
      {/* 没有显式 label 时也给一个可读名称，避免下拉变成"无名称控件"。 */}
      <SelectTrigger size="sm" aria-label={label ?? '下拉选择'} className="w-full">
        <SelectValue placeholder={placeholder ?? '请选择'} />
      </SelectTrigger>
      <SelectContent>
        {data.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  label,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (value: number | undefined) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      className="h-8 w-full"
      aria-label={label}
      value={Number.isFinite(value) ? String(value) : ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        onChange(raw === '' ? undefined : Number(raw));
      }}
    />
  );
}

/** 说明气泡：用原生 title 承担，不为提示再引一套浮层。 */
export function Tooltip({
  label,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span title={label} className="inline-flex">
      {children}
    </span>
  );
}
