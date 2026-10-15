/**
 * P04 中性控件夹具。
 *
 * 目的：验证 Mantine 的关键交互、焦点与键盘行为是否可实现，
 * 以及 CSP/nonce 下运行时样式注入是否可用。
 * 它刻意不做产品视觉设计，也不是任何页面的原型。
 */

import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Group,
  Menu,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';

export function ControlsFixturePage() {
  const [modalOpen, modal] = useDisclosure(false);
  const [drawerOpen, drawer] = useDisclosure(false);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<string | null>('a');
  const [segment, setSegment] = useState('one');
  const [checked, setChecked] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [count, setCount] = useState<number | string>(3);

  return (
    <Stack p="lg" gap="md" maw={760} mx="auto">
      <Title order={3}>组件库控件夹具</Title>
      <Text size="sm" c="dimmed">
        仅用于技术验证：键盘与焦点、弹层与 portal、输入法与验证、动态样式与 nonce。
      </Text>

      <Group>
        <Button>主按钮</Button>
        <Button variant="default">次按钮</Button>
        <ActionIcon aria-label="图标按钮" variant="default">
          ★
        </ActionIcon>
        <Menu>
          <Menu.Target>
            <Button variant="default">菜单</Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item>第一项</Menu.Item>
            <Menu.Item>第二项</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <TextInput
        label="文本输入（输入法）"
        placeholder="输入中文以验证 IME"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <NumberInput
        label="数字输入"
        value={count}
        onChange={setCount}
        min={0}
        max={100}
      />
      <Select
        label="单选下拉"
        data={[
          { value: 'a', label: '选项 A' },
          { value: 'b', label: '选项 B' },
        ]}
        value={choice}
        onChange={setChoice}
        checkIconPosition="right"
      />
      <SegmentedControl
        value={segment}
        onChange={setSegment}
        data={[
          { value: 'one', label: '一' },
          { value: 'two', label: '二' },
        ]}
      />
      <Group>
        <Checkbox
          label="复选框"
          checked={checked}
          onChange={(event) => setChecked(event.currentTarget.checked)}
        />
        <Switch
          label="开关"
          checked={switched}
          onChange={(event) => setSwitched(event.currentTarget.checked)}
        />
      </Group>

      <Group>
        <Button onClick={modal.open}>打开对话框</Button>
        <Button variant="default" onClick={drawer.open}>
          打开抽屉
        </Button>
      </Group>

      <Tabs defaultValue="first">
        <Tabs.List>
          <Tabs.Tab value="first">标签一</Tabs.Tab>
          <Tabs.Tab value="second">标签二</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="first" pt="sm">
          <Text size="sm">面板一</Text>
        </Tabs.Panel>
        <Tabs.Panel value="second" pt="sm">
          <Text size="sm">面板二</Text>
        </Tabs.Panel>
      </Tabs>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>名称</Table.Th>
            <Table.Th>状态</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>示例条目</Table.Td>
            <Table.Td>等待</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>

      <Alert title="提示" color="blue">
        运行时样式注入应在 CSP 下通过 nonce 生效。
      </Alert>

      <Modal opened={modalOpen} onClose={modal.close} title="对话框">
        <Stack gap="sm">
          <Text size="sm">Esc 关闭并通过 portal 恢复焦点。</Text>
          <Group>
            <Button onClick={modal.close}>确认</Button>
            <Button variant="default" onClick={modal.close}>
              取消
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Drawer opened={drawerOpen} onClose={drawer.close} title="抽屉">
        <Text size="sm">抽屉内容</Text>
      </Drawer>
    </Stack>
  );
}
