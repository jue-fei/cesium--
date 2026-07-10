"""pytest 共享夹具"""
import sys
import os
# 将 backend-py 加入 sys.path，使测试能 import app.*
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest


@pytest.fixture
def sample_rock():
    from app.services.blasting.blast_physics import RockMedium
    return RockMedium()


@pytest.fixture
def granite_rock():
    from app.services.blasting.blast_physics import RockMedium
    return RockMedium(
        density=2700,
        youngs_modulus=50e9,
        poissons_ratio=0.25,
        ucs=120e6,
        tensile_strength=10e6,
        p_wave_speed=5500,
        s_wave_speed=3200,
    )
