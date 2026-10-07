"""平台内置通用组件库（global components）。

本包随 agent-ui 执行引擎分发，通过 ``AGENT_UI_SDK_PATH`` 注入的 PYTHONPATH
对组件进程可见——业务仓库不需要安装、不需要 vendor、也不感知它的物理位置。

业务侧只通过组件 ``entry_point`` 中的保留关键字使用这些内置能力，例如::

    @global_components.script_runner

可执行模块约定：每个可被 ``python -m`` 调起的内置组件都是本包下的一个子包，
且提供 ``__main__`` 模块。保留前缀为 ``@``，其余形态的 entry_point 仍按
业务仓库内的文件路径处理。
"""
