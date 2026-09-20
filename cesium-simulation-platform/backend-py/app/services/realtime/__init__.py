"""
realtime 域 —— 全域实时推送（/ws/realtime/{scope}）

telemetry.py 定义 TelemetryAdapter 数据源适配器：
  SimTelemetryAdapter   模拟数据源（当前使用）：从调度仿真器读设备状态，
                        传感器曲线用固定 seed 生成
  MqttTelemetryAdapter  真实数据接入点（预留 stub）：将来井下/边缘网关
                        按 MQTT 上报时实现此适配器即可，WS 帧协议不变
"""
