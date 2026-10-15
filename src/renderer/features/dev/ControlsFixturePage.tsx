/**
 * 开发入口：组件库中性控件夹具 + 演示状态切换工具。
 *
 * 夹具只用于验证控件、焦点与 CSP；演示场景工具只影响本机演示数据，
 * 明确放在开发入口，不进入产品页面。
 */

import {
  ActionIcon,
  Alert,
  Badge,
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
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { updateDemoState, useDemoState, type DemoScenario } from '../../mock/demo-store';
import { useMediaService } from '../../shared/api/service-context';
import styles from './ControlsFixturePage.module.css';

const SCENARIOS: ReadonlyArray<{ value: DemoScenario; label: string; hint: string }> = [
  { value: 'default', label: '默认', hint: '约 240 条演示作品的正常媒体库' },
  { value: 'empty', label: '空库', hint: '来源与作品都为空，用于检查空状态' },
  { value: 'loading', label: '长加载', hint: '读取保持等待，用于检查加载状态' },
  { value: 'error', label: '失败', hint: '读取返回错误，用于检查失败与重试' },
];

export function ControlsFixturePage() {
  const [modalOpen, modal] = useDisclosure(false);
  const [drawerOpen, drawer] = useDisclosure(false);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<string | null>('a');
  const [segment, setSegment] = useState('one');
  const [checked, setChecked] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [count, setCount] = useState<number | string>(3);
  const service = useMediaService();
  const queryClient = useQueryClient();
  const demo = useDemoState();

  return (
    <Stack p="lg" gap="lg" maw={820} mx="auto" data-route="dev">
      <Stack gap={4}>
        <Title order={3}>开发入口</Title>
        <Text size="sm" c="dimmed">
          组件库夹具与演示状态工具；不进入产品导航，也不影响真实数据。
        </Text>
      </Stack>

      <section className={styles.block}>
        <Title order={4}>演示场景</Title>
        <Text size="sm" c="dimmed">
          当前场景：{demo.scenario}
        </Text>
        <Group gap="xs">
          {SCENARIOS.map((scenario) => (
            <Button
              key={scenario.value}
              size="xs"
              variant={demo.scenario === scenario.value ? 'filled' : 'default'}
              onClick={() => {
                updateDemoState(() => ({ scenario: scenario.value }));
                void queryClient.invalidateQueries();
              }}
              title={scenario.hint}
            >
              {scenario.label}
            </Button>
          ))}
          <Button
            size="xs"
            variant="default"
            onClick={() =>
              void service.resetDemoData().then(() => {
                void queryClient.invalidateQueries();
              })
            }
          >
            重置演示数据
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          「长加载」场景会保持读取等待：它用于人工检查加载态，不影响其它场景。
        </Text>
      </section>

      <section className={styles.block}>
        <Title order={4}>开发路由</Title>
        <Group gap="xs">
          <Button component={Link} to="/dev/session" size="xs" variant="default">
            桌面链路自检（真实后端路径）
          </Button>
          <Button component={Link} to="/" size="xs" variant="default">
            返回首页
          </Button>
        </Group>
      </section>

      <section className={styles.block}>
        <Title order={4}>组件库控件夹具</Title>
        <Group>
          <Button>主按钮</Button>
          <Button variant="default">次按钮</Button>
          <ActionIcon aria-label="图标按钮" variant="default">
            ★
          </ActionIcon>
          <Menu withinPortal>
            <Menu.Target>
              <Button variant="default">菜单</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item>第一项</Menu.Item>
              <Menu.Item>第二项</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Badge variant="light">标签</Badge>
        </Group>

        <TextInput
          label="文本输入（输入法）"
          placeholder="输入中文以验证 IME"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <NumberInput label="数字输入" value={count} onChange={setCount} min={0} max={100} />
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
      </section>

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
