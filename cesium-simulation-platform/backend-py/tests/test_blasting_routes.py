"""爆破模块路由单元测试

覆盖路由（均为无 DB 依赖的物理计算路由）：
- POST /api/blasting/validate/kco     → validate_kco()
- POST /api/blasting/physics/jwl       → physics_jwl()
- POST /api/blasting/physics/vibration → physics_vibration()
- POST /api/blasting/damage-zones      → compute_damage_zones()
- POST /api/blasting/ppv-field         → compute_ppv_field()
- POST /api/blasting/jwl-curve         → compute_jwl_curve()
- POST /api/blasting/calibrate         → calibrate_sadosky()

测试策略：
  TestClient 在当前环境（starlette 0.35.1 + httpx 0.28.1）存在版本不兼容，
  因此直接调用路由处理函数（import 函数直接调用），并使用 Pydantic schema
  对象作为参数。Schema 验证测试通过构造非法参数触发 ValidationError。
"""
import base64
import numpy as np
import pytest
from pydantic import ValidationError

from app.routes.blasting import (
    validate_kco,
    physics_jwl,
    physics_vibration,
    compute_ppv_field,
    compute_damage_zones,
    compute_jwl_curve,
    calibrate_sadosky,
    _json_obj_to_api,
    _api_to_json_obj,
    ENV_ROCK_MAP,
    ENV_ROCK_MAP_REV,
)
from app.schemas import (
    KCOValidateRequest,
    JWLRequest,
    VibrationRequest,
    PPVFieldRequest,
    DamageZoneRequest,
    JWLCurveRequest,
    CalibrateRequest,
    CalibrateMeasurement,
    BlastingDesignSave,
    RockParamsInput,
)


# ============================================================
# KCO 验证路由
# ============================================================

class TestKCORoute:

    def test_validate_kco_typical(self):
        """典型 KCO 请求：n≈0.7916"""
        req = KCOValidateRequest(Q=320, A=3.6, RWS=100, B=1.5, d=0.04, W_abs=0.2)
        result = validate_kco(req)
        assert result["code"] == 0
        assert "x50" in result["data"]
        assert "n" in result["data"]
        assert abs(result["data"]["n"] - 0.7916) < 0.01

    def test_validate_kco_default_params(self):
        """默认参数 KCO 请求"""
        req = KCOValidateRequest(Q=100)
        result = validate_kco(req)
        assert result["code"] == 0
        assert result["data"]["x50"] > 0

    def test_validate_kco_a_above_range_rejected(self):
        """A > 22 应被 schema 拒绝（ValidationError）"""
        with pytest.raises(ValidationError):
            KCOValidateRequest(Q=100, A=25.0, RWS=100, B=1.5, d=0.04, W_abs=0.2)

    def test_validate_kco_a_zero_rejected(self):
        """A=0 应被 schema 拒绝（gt=0）"""
        with pytest.raises(ValidationError):
            KCOValidateRequest(Q=100, A=0.0, RWS=100, B=1.5, d=0.04, W_abs=0.2)

    def test_validate_kco_q_zero_rejected(self):
        """Q=0 应被 schema 拒绝（gt=0）"""
        with pytest.raises(ValidationError):
            KCOValidateRequest(Q=0, A=3.6, RWS=100, B=1.5, d=0.04, W_abs=0.2)

    def test_validate_kco_response_fields(self):
        """响应包含所有字段"""
        req = KCOValidateRequest(Q=200, A=5.0, RWS=100, B=2.0, d=0.05, W_abs=0.1)
        result = validate_kco(req)
        data = result["data"]
        assert "x50" in data
        assert "n" in data
        assert "x80" in data
        assert "uniformity" in data
        assert "oversizeRatio" in data


# ============================================================
# JWL 状态方程路由
# ============================================================

class TestJWLRoute:

    def test_physics_jwl_emulsion(self):
        """JWL 乳化炸药请求"""
        req = JWLRequest(charge_kg=100, explosive_type="emulsion", relative_volume=1.0)
        result = physics_jwl(req)
        assert result["code"] == 0
        assert result["data"]["pressure"] > 1e9  # GPa 级

    def test_physics_jwl_three_explosives(self):
        """三种炸药返回不同压力"""
        results = {}
        for exp in ["emulsion", "anfo", "dynamite"]:
            req = JWLRequest(charge_kg=100, explosive_type=exp, relative_volume=1.0)
            result = physics_jwl(req)
            results[exp] = result["data"]["pressure"]
        assert len(set(results.values())) == 3

    def test_physics_jwl_pressure_decreases(self):
        """膨胀（V 增大）压力下降"""
        req1 = JWLRequest(charge_kg=100, explosive_type="emulsion", relative_volume=1.0)
        req10 = JWLRequest(charge_kg=100, explosive_type="emulsion", relative_volume=10.0)
        p1 = physics_jwl(req1)["data"]["pressure"]
        p10 = physics_jwl(req10)["data"]["pressure"]
        assert p1 > p10

    def test_physics_jwl_default_explosive(self):
        """默认炸药类型为 emulsion"""
        req = JWLRequest(charge_kg=100, relative_volume=1.0)
        result = physics_jwl(req)
        assert result["data"]["explosiveType"] == "emulsion"


# ============================================================
# 萨道夫斯基振动路由
# ============================================================

class TestVibrationRoute:

    def test_physics_vibration_default_rock(self):
        """振动预测（默认岩体参数）"""
        req = VibrationRequest(charge_kg=100, distance=50)
        result = physics_vibration(req)
        assert result["code"] == 0
        assert result["data"]["velocity"] > 0

    def test_physics_vibration_distance_decay(self):
        """距离增大 → 振速减小"""
        req_near = VibrationRequest(charge_kg=100, distance=10)
        req_far = VibrationRequest(charge_kg=100, distance=100)
        v_near = physics_vibration(req_near)["data"]["velocity"]
        v_far = physics_vibration(req_far)["data"]["velocity"]
        assert v_near > v_far

    def test_physics_vibration_response_fields(self):
        """响应包含 chargeKg 和 distance"""
        req = VibrationRequest(charge_kg=100, distance=50)
        result = physics_vibration(req)
        assert result["data"]["chargeKg"] == 100
        assert result["data"]["distance"] == 50


# ============================================================
# 损伤区路由
# ============================================================

class TestDamageZonesRoute:

    def test_damage_zones_schema_conflict(self):
        """damage-zones 路由 elastic_zone_start 可为 None（schema 已修复）

        Task 3 将 elastic_radius 改为 None，对应 schemas.py 中
        DamageZoneResponse.elastic_zone_start 已改为 Optional[float] 接受 None。
        此测试验证修复后路由不再抛 ValidationError，且 elastic_zone_start=None。
        """
        req = DamageZoneRequest(
            charge_kg=100, explosive_density=1200, VoD=4500,
            rock_ucs=120e6, rock_tensile=10e6
        )
        result = compute_damage_zones(req)
        # 修复后：路由正常返回，不抛 ValidationError
        assert result.charge_radius > 0
        assert result.detonation_pressure > 0
        assert result.crushed_radius > 0
        assert result.fractured_radius > result.crushed_radius
        # elastic_zone_start 可为 None（弹性区无外边界）
        assert result.elastic_zone_start is None

    def test_damage_zones_physics_correct(self):
        """损伤区底层物理计算正确（绕过 schema 冲突，直接测试 damage_zone_radii）"""
        from app.services.blasting.blast_physics import damage_zone_radii
        r_charge = (3 * 100 / (4 * np.pi * 1200)) ** (1 / 3)
        p_det = 1200 * 4500 ** 2 / 4
        zones = damage_zone_radii(r_charge, 120e6, 10e6, p_det)
        assert zones["crushed_radius"] > 0
        assert zones["fractured_radius"] > zones["crushed_radius"]
        assert zones["elastic_radius"] is None


# ============================================================
# PPV 波场路由
# ============================================================

class TestPPVFieldRoute:

    def test_ppv_field_typical(self):
        """典型 PPV 波场请求"""
        req = PPVFieldRequest(
            charge_kg=100, time=0.01,
            x_min=-50, x_max=50, y_min=-50, y_max=50,
            nx=50, ny=50
        )
        result = compute_ppv_field(req)
        assert result.nx == 50
        assert result.ny == 50
        assert len(result.grid_x) == 50
        assert len(result.grid_y) == 50
        assert result.ppv_dtype == "float32"
        assert isinstance(result.ppv_b64, str)

    def test_ppv_field_decodable(self):
        """PPV base64 数据可解码为 float32 数组"""
        req = PPVFieldRequest(charge_kg=100, time=0.01, nx=20, ny=20)
        result = compute_ppv_field(req)
        raw = base64.b64decode(result.ppv_b64)
        field = np.frombuffer(raw, dtype=np.float32).reshape(result.ny, result.nx)
        assert field.shape == (20, 20)
        assert np.all(np.isfinite(field))

    def test_ppv_field_t_zero_all_zero(self):
        """t=0 时波场全零"""
        req = PPVFieldRequest(charge_kg=100, time=0.0, nx=20, ny=20)
        result = compute_ppv_field(req)
        assert result.max_ppv == 0.0
        assert result.mean_ppv == 0.0

    def test_ppv_field_nx_above_max_rejected(self):
        """nx > 200 应被 schema 拒绝（le=200）

        PPVFieldRequest.nx 字段约束 ge=10, le=200，路由中
        `nx = min(req.nx, 200)` 的 clamp 逻辑对 schema 校验后的请求不可达。
        这里验证 schema 在构造阶段已拒绝越界值。
        """
        with pytest.raises(ValidationError):
            PPVFieldRequest(charge_kg=100, time=0.01, nx=300, ny=300)

    def test_ppv_field_nx_below_min_rejected(self):
        """nx < 10 应被 schema 拒绝（ge=10）"""
        with pytest.raises(ValidationError):
            PPVFieldRequest(charge_kg=100, time=0.01, nx=5, ny=5)

    def test_ppv_field_nx_at_boundary(self):
        """nx=200 (上限边界值) 合法"""
        req = PPVFieldRequest(charge_kg=100, time=0.01, nx=200, ny=200)
        result = compute_ppv_field(req)
        assert result.nx == 200
        assert result.ny == 200


# ============================================================
# JWL 曲线路由
# ============================================================

class TestJWLCurveRoute:

    def test_jwl_curve_emulsion(self):
        """JWL 等熵膨胀曲线"""
        req = JWLCurveRequest(explosive_type="emulsion")
        result = compute_jwl_curve(req)
        assert len(result.relative_volume) == 100
        assert len(result.pressure_pa) == 100

    def test_jwl_curve_pressure_decreases(self):
        """曲线压力随体积增大而下降"""
        req = JWLCurveRequest(explosive_type="emulsion")
        result = compute_jwl_curve(req)
        pressures = result.pressure_pa
        assert pressures[0] > pressures[-1]

    def test_jwl_curve_three_explosives(self):
        """三种炸药曲线不同"""
        curves = {}
        for exp in ["emulsion", "anfo", "dynamite"]:
            req = JWLCurveRequest(explosive_type=exp)
            result = compute_jwl_curve(req)
            curves[exp] = result.pressure_pa[0]
        assert len(set(curves.values())) == 3


# ============================================================
# 萨道夫斯基常数反演路由
# ============================================================

class TestCalibrateRoute:

    def test_calibrate_valid(self):
        """正常反演请求"""
        K_true, alpha_true = 200.0, 1.5
        measurements = []
        for Q, R in [(100, 50), (100, 100), (50, 50), (200, 80), (150, 60)]:
            ppv = K_true * (Q ** (1 / 3) / R) ** alpha_true
            measurements.append(
                CalibrateMeasurement(charge_kg=Q, distance=R, ppv=ppv)
            )
        req = CalibrateRequest(measurements=measurements)
        result = calibrate_sadosky(req)
        assert abs(result.K - K_true) < 1.0
        assert abs(result.alpha - alpha_true) < 0.01
        assert result.r_squared > 0.99

    def test_calibrate_too_few_measurements_rejected(self):
        """少于 3 组数据 → schema ValidationError（min_length=3）"""
        with pytest.raises(ValidationError):
            CalibrateRequest(measurements=[
                CalibrateMeasurement(charge_kg=100, distance=50, ppv=5.0),
                CalibrateMeasurement(charge_kg=100, distance=100, ppv=2.0),
            ])


# ============================================================
# tensileStrength 单位转换（Task 9）
# ============================================================

class TestTensileStrengthConversion:
    """Task 9：tensileStrength 单位转换（DB 以 MPa 存储，API 以 Pa 交互）

    修复前 _json_obj_to_api / _api_to_json_obj 漏掉 tensileStrength 转换，
    导致 GET 返回 8（应为 8e6 Pa）、POST 存 8e6（应为 8 MPa），差 100 万倍。
    """

    def test_db_mpa_to_api_pa(self):
        """DB 存 8 (MPa) → API 返回 8e6 (Pa)"""
        api_obj = _json_obj_to_api({"抗拉强度_MPa": 8}, ENV_ROCK_MAP)
        assert api_obj["tensileStrength"] == 8e6

    def test_api_pa_to_db_mpa(self):
        """API 输入 8e6 (Pa) → DB 存 8 (MPa)"""
        db_obj = _api_to_json_obj({"tensileStrength": 8e6}, ENV_ROCK_MAP_REV)
        assert db_obj["抗拉强度_MPa"] == 8

    def test_roundtrip_granite(self):
        """花岗岩抗拉强度 8 MPa 双向往返一致：DB(8) → API(8e6) → DB(8)"""
        api_obj = _json_obj_to_api({"抗拉强度_MPa": 8}, ENV_ROCK_MAP)
        assert api_obj["tensileStrength"] == 8e6
        db_obj = _api_to_json_obj(api_obj, ENV_ROCK_MAP_REV)
        assert db_obj["抗拉强度_MPa"] == 8

    def test_validator_mpa_input_normalized(self):
        """schemas validator：输入 8 (MPa, <1000) 归一化为 8e6 (Pa)"""
        rp = RockParamsInput(tensile_strength=8)
        assert rp.tensile_strength == 8e6

    def test_validator_pa_input_preserved(self):
        """schemas validator：输入 8e6 (Pa, >=1000) 保留不变"""
        rp = RockParamsInput(tensile_strength=8e6)
        assert rp.tensile_strength == 8e6


# ============================================================
# charge_density 约束（Task 10）
# ============================================================

class TestChargeDensityConstraint:
    """Task 10：charge_density_* 约束 le=10（线装药密度 kg/m 典型 0.5~2.0）

    修复前 le=1 与种子数据（1.0/1.2/1.5）冲突，导致设计保存被拒。
    """

    def test_seed_value_1_5_accepted(self):
        """种子数据 charge_density_cut=1.5 可通过校验（原 le=1 会拒绝）"""
        design = BlastingDesignSave(charge_density_cut=1.5)
        assert design.charge_density_cut == 1.5

    def test_value_2_0_accepted(self):
        """charge_density_aux=2.0（隧道爆破典型上限）可通过"""
        design = BlastingDesignSave(charge_density_aux=2.0)
        assert design.charge_density_aux == 2.0

    def test_above_10_rejected(self):
        """charge_density_cut=10.5 超过 le=10 应被拒绝"""
        with pytest.raises(ValidationError):
            BlastingDesignSave(charge_density_cut=10.5)

    def test_floor_field_present(self):
        """charge_density_floor 字段存在且可赋值（DB 有底板线装药密度列）"""
        design = BlastingDesignSave(charge_density_floor=1.0)
        assert design.charge_density_floor == 1.0
