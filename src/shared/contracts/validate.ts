/**
 * 极小的运行时校验工具（ADR-11 的“共享TS业务契约 + 运行时校验”）。
 *
 * 故意不引入第三方 schema 库：Zod 版本与生成工具仍属 P07 待锁定项，
 * 在没有通过验证前不作为既定事实进入产品依赖。
 * 校验只处理 JSON 形状，不做领域推导，也不改写后端事实。
 */

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

export function valid<T>(value: T): Validation<T> {
  return { ok: true, value };
}

export function invalid<T>(...issues: string[]): Validation<T> {
  return { ok: false, issues };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ObjectField<T> {
  readonly read: (value: unknown) => Validation<T>;
  readonly optional?: boolean;
}

export function field<T>(
  read: (value: unknown) => Validation<T>,
  optional = false,
): ObjectField<T> {
  return { optional, read };
}

export type Reader<T> = (value: unknown) => Validation<T>;

export const string = (): Reader<string> => (value) =>
  typeof value === 'string' ? valid(value) : invalid('期望字符串');

export const number = (): Reader<number> => (value) =>
  typeof value === 'number' && Number.isFinite(value) ? valid(value) : invalid('期望有限数字');

export const boolean = (): Reader<boolean> => (value) =>
  typeof value === 'boolean' ? valid(value) : invalid('期望布尔值');

export const unknownReader: Reader<unknown> = (value) => valid(value);

export function arrayOf<T>(item: Reader<T>): Reader<T[]> {
  return (value) => {
    if (!Array.isArray(value)) {
      return invalid('期望数组');
    }
    const items: T[] = [];
    const issues: string[] = [];
    value.forEach((entry, index) => {
      const result = item(entry);
      if (result.ok) {
        items.push(result.value);
      } else {
        issues.push(`[${index}] ${result.issues.join('; ')}`);
      }
    });
    return issues.length > 0 ? invalid(...issues) : valid(items);
  };
}

export function recordOf<T>(item: Reader<T>): Reader<Record<string, T>> {
  return (input) => {
    if (!isRecord(input)) {
      return invalid('期望对象');
    }
    const output: Record<string, T> = {};
    const issues: string[] = [];
    for (const [key, entry] of Object.entries(input)) {
      const result = item(entry);
      if (result.ok) {
        output[key] = result.value;
      } else {
        issues.push(`${key}: ${result.issues.join('; ')}`);
      }
    }
    return issues.length > 0 ? invalid(...issues) : valid(output);
  };
}

/**
 * 允许后端新增可选字段，但已声明字段必须是预期形状。
 * `optional` 只表示"键可能缺席"；键存在时（即使值为 null）一律交给
 * 字段自身的 reader 裁决，需要接受 null 的字段必须显式使用 `nullable`。
 */
export function objectWith<T extends object>(
  schema: { readonly [K in keyof T]: ObjectField<T[K]> },
): Reader<T> {
  return (value) => {
    if (!isRecord(value)) {
      return invalid('期望对象');
    }
    const output: Partial<Record<keyof T, unknown>> = {};
    const issues: string[] = [];
    for (const key of Object.keys(schema) as Array<keyof T>) {
      const spec = schema[key];
      const name = String(key);
      const raw = value[name];
      const present = Object.prototype.hasOwnProperty.call(value, name);
      if (!present) {
        if (spec.optional) {
          continue;
        }
        issues.push(`${name}: 缺少必需字段`);
        continue;
      }
      const result = spec.read(raw);
      if (result.ok) {
        output[key] = result.value;
      } else {
        issues.push(`${name}: ${result.issues.join('; ')}`);
      }
    }
    return issues.length > 0 ? invalid(...issues) : valid(output as T);
  };
}

export function nullable<T>(item: Reader<T>): Reader<T | null> {
  return (value) => (value === null || value === undefined ? valid(null) : item(value));
}
