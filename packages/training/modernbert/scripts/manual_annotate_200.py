"""Claude in-session manual annotation of 200 human_eval queries.

ANNOTATIONS list contains tuples (if_, code, math, wk, pa, cs) in same order
as sample_200.csv. Each value is Claude's semantic judgement (not heuristic).
Granularity: {0.0, 0.3, 0.5, 0.7, 0.8, 1.0} per judge prompt scale.
"""

from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
IN = ROOT / "data" / "human_eval" / "sample_200.csv"
OUT = ROOT / "data" / "human_eval" / "sample_200_filled.csv"
DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]

# Order: (instruction_following, coding, math_reasoning, world_knowledge, planning_agentic, creative_synthesis)
ANNOTATIONS = [
    (0.5, 0.0, 0.0, 1.0, 0.3, 0.3),  # 000 homeopathy vs Chinese medicine
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 001 capital Australia
    (0.3, 0.3, 0.0, 0.0, 0.8, 0.0),  # 002 Q3 reports + email + bug prioritize
    (0.3, 0.7, 0.0, 0.3, 1.0, 0.3),  # 003 knowledge mgmt plan NER RSS
    (1.0, 0.5, 0.0, 0.3, 0.0, 0.3),  # 004 JSON library catalog strict
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 005 capital Australia dup
    (1.0, 0.0, 0.0, 0.0, 0.0, 0.3),  # 006 3 adjectives sunny day strict
    (0.7, 0.0, 0.0, 0.5, 0.5, 0.5),  # 007 compliance officer fintech draft
    (0.7, 0.0, 0.0, 0.3, 0.0, 0.0),  # 008 list 3 fruits bulleted
    (0.5, 1.0, 0.5, 0.3, 0.0, 0.0),  # 009 refactor Python O(n²)→O(n log n)
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 010 capital Australia variant
    (0.5, 0.5, 0.0, 0.7, 1.0, 0.3),  # 011 Django→microservices AWS migration
    (0.7, 1.0, 0.3, 0.3, 0.0, 0.0),  # 012 thread-safe Priority Queue Rust
    (0.7, 0.0, 0.0, 0.0, 0.0, 1.0),  # 013 sci-fi 400-word generation ship
    (0.5, 1.0, 0.0, 0.0, 0.0, 0.0),  # 014 Python add_numbers
    (0.3, 0.0, 0.0, 1.0, 0.0, 0.0),  # 015 geological formation riddle
    (0.7, 1.0, 0.3, 0.0, 0.0, 0.0),  # 016 Python calculate_tax
    (0.3, 0.0, 0.0, 0.8, 0.8, 0.3),  # 017 Kyoto 3-day itinerary
    (0.7, 0.0, 0.0, 0.0, 0.0, 0.0),  # 018 3 words starting S
    (0.3, 0.0, 1.0, 0.0, 0.0, 0.0),  # 019 baker flour percentages
    (0.3, 0.0, 1.0, 0.0, 0.0, 0.0),  # 020 set S integer pairs triangle
    (0.7, 1.0, 0.3, 0.3, 0.0, 0.0),  # 021 refactor Python LSP + lock-free
    (0.5, 0.0, 0.0, 0.3, 1.0, 0.3),  # 022 team offsite 2-day itinerary
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 023 revenue Q1Q2Q3 reverse engineer
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 024 mountain vertical drop
    (0.5, 0.0, 0.0, 0.3, 0.7, 1.0),  # 025 narrative designer interactive fiction
    (1.0, 0.3, 0.0, 0.0, 0.0, 0.0),  # 026 rewrite paragraph→JSON strict
    (0.3, 1.0, 0.3, 0.0, 0.0, 0.0),  # 027 Python peak element mountain
    (0.5, 0.3, 0.0, 0.7, 1.0, 0.0),  # 028 CI/CD pipeline microservices K8s
    (0.7, 0.0, 0.0, 0.0, 0.0, 1.0),  # 029 sci-fi 3-paragraph memory archivist
    (1.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 030 50-word micro-story twist
    (0.5, 0.5, 0.0, 0.7, 1.0, 0.0),  # 031 backend incident response microservices
    (1.0, 0.3, 0.0, 0.5, 0.3, 0.3),  # 032 NexusDB tech spec strict
    (0.5, 1.0, 0.3, 0.3, 0.0, 0.0),  # 033 Kadane max subarray
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 034 rectangle 24 area dimensions
    (0.5, 1.0, 0.0, 0.3, 0.3, 0.0),  # 035 NewsAPI fetch filter AI
    (1.0, 0.5, 0.0, 0.0, 0.0, 0.0),  # 036 JSON→YAML strict format
    (0.5, 1.0, 0.0, 0.0, 0.3, 0.0),  # 037 Python subprocess copy
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 038 garden perimeter 60m area
    (0.5, 0.3, 0.0, 0.7, 1.0, 0.3),  # 039 DevOps fintech automation
    (0.5, 0.0, 0.0, 0.0, 0.3, 1.0),  # 040 magical realism + hard SF
    (0.5, 0.5, 0.0, 0.7, 1.0, 0.3),  # 041 DAO platform Ethereum Polygon
    (0.5, 1.0, 0.3, 0.0, 0.0, 0.0),  # 042 Python calculate_average
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 043 Capital Australia + first PM
    (0.3, 0.0, 0.0, 0.0, 0.3, 1.0),  # 044 brainstorm bedtime story app
    (0.5, 0.0, 0.0, 0.7, 1.0, 0.3),  # 045 7-day Appalachian Trail
    (1.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 046 poem W-only letters
    (1.0, 0.3, 0.0, 0.5, 0.5, 0.3),  # 047 AetherID identity spec strict
    (0.7, 0.0, 0.0, 0.0, 0.3, 0.3),  # 048 email beta delay structured
    (0.7, 0.0, 0.0, 0.5, 0.0, 0.3),  # 049 10 solar energy benefits
    (0.0, 0.0, 0.0, 0.8, 0.0, 0.0),  # 050 CMYK primary colors
    (1.0, 0.3, 0.0, 0.3, 0.5, 0.3),  # 051 legacy tech docs multi-format
    (0.5, 0.7, 0.0, 0.3, 1.0, 0.0),  # 052 multi-agent support tickets
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 053 bakery cupcakes change
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 054 capital Australia dup
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 055 Metal Gear antagonist
    (0.5, 0.8, 0.3, 0.0, 0.7, 0.0),  # 056 stock price monitor 50 stocks
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 057 n^4+4 prime sum
    (0.0, 0.0, 0.8, 0.0, 0.0, 0.0),  # 058 3 notebooks 2 pens total
    (0.5, 0.5, 0.0, 0.0, 1.0, 0.0),  # 059 LinkedIn lead gen workflow
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 060 capital Australia dup
    (0.8, 0.0, 0.3, 0.3, 0.7, 0.5),  # 061 meal plan family budget $150
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 062 inscribed square circle ratio
    (0.3, 0.0, 0.0, 1.0, 0.0, 0.0),  # 063 insulin glargine vs detemir
    (0.5, 0.7, 0.0, 0.5, 1.0, 0.3),  # 064 finance tracker React Firebase
    (0.3, 0.0, 0.0, 0.3, 0.3, 1.0),  # 065 Aetheria luxury travel brand
    (0.5, 1.0, 0.0, 0.0, 0.0, 0.0),  # 066 Python even descending
    (0.5, 1.0, 0.3, 0.3, 0.0, 0.0),  # 067 find_max_subarray_sum
    (0.5, 0.3, 0.0, 0.7, 1.0, 0.0),  # 068 DevOps Java→microservices
    (0.5, 1.0, 0.0, 0.0, 0.3, 0.0),  # 069 bash PDF urgent email
    (0.0, 0.0, 0.8, 0.0, 0.0, 0.0),  # 070 car 120mi/2h speed
    (0.3, 0.0, 1.0, 0.0, 0.0, 0.0),  # 071 120 apples 3 baskets
    (0.3, 0.0, 0.0, 1.0, 0.0, 0.0),  # 072 Versailles vs Vienna
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 073 cat baker poem
    (0.5, 1.0, 0.0, 0.0, 0.0, 0.0),  # 074 Python CSV sales_data
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 075 discrete-time finance T=3
    (1.0, 0.3, 0.0, 0.3, 0.0, 0.3),  # 076 API docs /v1/users/export strict
    (0.3, 0.0, 1.0, 0.0, 0.0, 0.0),  # 077 circular track 3 runners
    (0.0, 0.0, 0.0, 1.0, 0.0, 0.0),  # 078 100 Years Solitude author
    (0.8, 0.0, 0.0, 0.3, 0.7, 0.7),  # 079 Green Roots Collective proposal
    (0.5, 0.0, 0.0, 0.0, 0.5, 1.0),  # 080 Chronos Fracture RPG narrative
    (0.3, 0.0, 1.0, 0.5, 0.5, 0.0),  # 081 3-year portfolio min 25% return
    (0.7, 1.0, 0.0, 0.3, 0.0, 0.0),  # 082 Python Linked List scratch
    (0.3, 0.0, 1.0, 0.0, 0.3, 0.0),  # 083 widgets Alpha Beta optimize
    (0.3, 0.0, 0.0, 1.0, 0.0, 0.0),  # 084 5 most populous countries
    (0.5, 0.0, 0.0, 0.0, 0.0, 1.0),  # 085 Cloud Cotton pajamas
    (0.5, 0.0, 0.0, 0.5, 1.0, 0.3),  # 086 3-day retreat 12 ppl SF
    (0.3, 0.0, 1.0, 0.0, 0.0, 0.0),  # 087 garden pond grass cost
    (0.3, 1.0, 0.0, 0.0, 0.0, 0.0),  # 088 Python even numbers
    (0.7, 1.0, 0.0, 0.3, 0.0, 0.0),  # 089 asyncio semaphore refactor
    (0.5, 0.0, 0.0, 0.0, 0.0, 1.0),  # 090 horror Echo Chamber smart home
    (1.0, 0.3, 0.0, 0.5, 0.3, 0.3),  # 091 NexusChain DLT docs index
    (0.7, 1.0, 0.3, 0.5, 0.0, 0.0),  # 092 lock-free ring buffer Rust
    (0.5, 0.3, 0.0, 0.7, 1.0, 0.0),  # 093 microservices e-commerce 3 svc
    (0.3, 0.0, 0.0, 0.0, 0.0, 1.0),  # 094 self-watering mug butler
    (0.5, 0.3, 0.0, 0.7, 1.0, 0.0),  # 095 DevOps disaster recovery AWS
    (0.7, 0.0, 0.0, 0.0, 0.0, 1.0),  # 096 200-300w abandoned library scene
    (1.0, 1.0, 0.0, 0.3, 0.3, 0.0),  # 097 Data Engineer Python sales CSV
    (0.5, 1.0, 0.0, 0.5, 0.3, 0.0),  # 098 Python security vulns CLI
    (1.0, 0.0, 0.0, 0.3, 0.0, 1.0),  # 099 4-stanza digital nostalgia
    (0.5, 0.8, 0.0, 0.5, 0.5, 0.0),  # 100 Python space race insights
    (0.3, 0.0, 0.0, 0.8, 0.3, 1.0),  # 101 trade agreement RPG + Opium Wars
    (0.5, 1.0, 0.3, 0.3, 1.0, 0.0),  # 102 multi-agent supply chain Python
    (0.3, 0.0, 0.7, 1.0, 0.0, 0.0),  # 103 1880 Ottoman British Pounds
    (0.7, 1.0, 0.8, 0.5, 0.0, 0.0),  # 104 QuantFlow Heston Python
    (0.5, 0.0, 0.0, 0.3, 0.5, 1.0),  # 105 Silent Symphony coffee campaign
    (0.7, 0.0, 0.5, 0.7, 0.3, 0.5),  # 106 trivia chemistry 5 questions
    (0.7, 1.0, 0.3, 0.0, 0.3, 0.0),  # 107 Python pandas CSV pipeline
    (0.3, 0.0, 0.0, 0.7, 1.0, 0.3),  # 108 5-day EU sustainable tourism
    (0.3, 0.0, 1.0, 1.0, 0.0, 0.0),  # 109 Earth kinetic + angular momentum
    (0.7, 1.0, 0.7, 0.5, 0.7, 0.0),  # 110 Python multi-agent VaR trading
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 111 penguin invent internet
    (0.5, 0.0, 0.0, 0.3, 0.0, 1.0),  # 112 sci-fi London Thames reservoir
    (1.0, 0.0, 0.7, 0.0, 0.0, 1.0),  # 113 micro-fiction bridge collapse calc
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 114 children Clockwork Garden
    (0.5, 0.0, 0.0, 0.7, 1.0, 0.3),  # 115 3-day Kyoto retreat eng team
    (0.3, 0.0, 0.0, 0.3, 0.3, 1.0),  # 116 Aetheria fashion biodegradable
    (0.7, 1.0, 0.5, 0.0, 1.0, 0.0),  # 117 Python multi-agent logistics
    (0.7, 0.0, 0.7, 0.3, 0.0, 0.0),  # 118 sqrt(144) brackets continents
    (0.7, 1.0, 0.0, 0.5, 0.0, 0.0),  # 119 Python IPv4 RFC 791 validate
    (0.5, 1.0, 0.3, 0.3, 0.7, 0.0),  # 120 Python 5x5 grid agent
    (0.5, 0.0, 0.0, 0.7, 0.3, 1.0),  # 121 Silk Road of Stars counterfactual
    (0.7, 1.0, 0.7, 0.5, 0.5, 0.0),  # 122 virus simulation Python 1000
    (0.5, 0.0, 0.0, 0.5, 0.3, 0.7),  # 123 email creative AquaPure history
    (0.7, 1.0, 0.5, 0.3, 0.3, 0.0),  # 124 Python CLI forecasting argparse
    (0.5, 0.0, 1.0, 0.7, 0.7, 0.0),  # 125 500kW hydroelectric plan
    (0.5, 1.0, 0.0, 0.0, 0.5, 0.0),  # 126 Python sales pipeline pandas
    (0.5, 0.7, 1.0, 0.3, 0.0, 0.0),  # 127 area x² and y=4 matplotlib
    (0.5, 1.0, 0.5, 0.0, 0.7, 0.0),  # 128 drone agent battery
    (0.3, 0.0, 0.0, 0.7, 0.0, 1.0),  # 129 Culinary Crossroads Silk Road
    (0.7, 1.0, 0.5, 0.0, 0.0, 0.0),  # 130 Python factorial recursion
    (0.5, 1.0, 0.3, 0.5, 0.0, 0.0),  # 131 Python top 5 temperature countries
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 132 Great Pyramid surface miles
    (0.5, 0.7, 0.3, 0.7, 1.0, 0.3),  # 133 Python agent Tokyo trip
    (0.5, 1.0, 0.5, 0.3, 0.0, 0.0),  # 134 Python max profit stock
    (0.3, 0.0, 0.0, 0.7, 0.3, 1.0),  # 135 Algorithmic Renaissance museum
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 136 0.44 caliber bullet KE
    (0.3, 0.0, 0.7, 1.0, 0.0, 0.0),  # 137 Giza-Colosseum distance speed
    (0.5, 1.0, 0.5, 0.3, 0.7, 0.0),  # 138 Tower of Hanoi recursive agent
    (0.5, 1.0, 0.0, 0.3, 1.0, 0.0),  # 139 distributed task queue agent
    (1.0, 0.7, 0.3, 0.0, 0.0, 1.0),  # 140 200w Last Algorithm + Python embed
    (0.7, 0.0, 0.8, 1.0, 0.0, 1.0),  # 141 quantum physicist 1927 screenplay
    (0.7, 1.0, 0.0, 0.0, 0.0, 0.0),  # 142 Python jsonplaceholder strict
    (0.7, 0.0, 0.0, 0.7, 1.0, 0.3),  # 143 3-day Kyoto sustainable narrative
    (0.5, 0.0, 0.0, 0.7, 1.0, 0.3),  # 144 3-day Costa Rica ecotourism
    (0.0, 0.0, 1.0, 0.0, 0.0, 0.0),  # 145 200m fence max area
    (1.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 146 astronaut star 5 syllables
    (0.5, 0.0, 0.0, 0.7, 1.0, 0.3),  # 147 Manchester industrial archaeology
    (0.7, 1.0, 0.0, 0.5, 0.5, 0.0),  # 148 DevOps Python health-check subprocess
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 149 NFL football surface
    (0.3, 0.0, 0.7, 1.0, 0.0, 0.0),  # 150 Apollo 11 elapsed seconds
    (0.5, 0.7, 0.7, 0.5, 0.3, 0.0),  # 151 EU budget Python projection
    (0.7, 0.0, 0.7, 0.0, 0.0, 0.0),  # 152 recipe total cost format
    (0.3, 0.3, 1.0, 0.3, 0.0, 0.0),  # 153 52-card probability adjacent ranks
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 154 Pyramid surface Pythagorean
    (0.5, 0.0, 0.0, 0.5, 1.0, 0.7),  # 155 Echoes of Tomorrow launch plan
    (0.5, 0.7, 1.0, 0.3, 0.0, 0.0),  # 156 partitions 12 items 3 bins Python
    (0.7, 1.0, 0.5, 0.3, 0.0, 0.0),  # 157 Python CoinGecko 7-day MA
    (1.0, 0.0, 0.0, 0.3, 0.0, 1.0),  # 158 5-stanza iambic pentameter AI
    (0.7, 1.0, 0.3, 0.3, 0.5, 0.0),  # 159 Python CLI digital assets
    (0.3, 0.0, 0.0, 0.3, 0.0, 1.0),  # 160 sci-fi Berlin renewable Kael
    (0.5, 0.0, 0.0, 0.8, 1.0, 0.3),  # 161 1-week Pacific NW road trip
    (0.3, 0.0, 0.0, 0.3, 0.5, 1.0),  # 162 sloth fable + atomic habits
    (0.5, 0.0, 0.0, 0.5, 0.0, 1.0),  # 163 zipper time-traveling historian
    (0.5, 1.0, 0.3, 0.3, 0.7, 0.0),  # 164 Python agent marketing funnel
    (0.3, 0.0, 1.0, 0.5, 0.0, 0.0),  # 165 cone slant Earth-Sun
    (0.5, 0.7, 0.0, 0.0, 1.0, 0.0),  # 166 AI news agent Python stubs
    (0.7, 1.0, 1.0, 0.5, 0.5, 0.0),  # 167 Python Gauss-Seidel agent
    (0.5, 1.0, 0.7, 0.5, 0.3, 0.0),  # 168 Python M/M/1 queue simulation
    (0.5, 1.0, 1.0, 0.3, 0.3, 0.0),  # 169 Python smallest n divisible
    (0.7, 0.0, 0.0, 0.5, 1.0, 0.7),  # 170 Chronos Digest newsletter
    (0.5, 1.0, 0.3, 0.0, 1.0, 0.0),  # 171 Python 3 agents resource grid
    (0.7, 0.5, 0.0, 0.3, 1.0, 0.3),  # 172 web dev portfolio plan
    (1.0, 0.0, 0.0, 0.3, 0.0, 1.0),  # 173 300w satirical fast fashion
    (0.5, 1.0, 0.0, 0.0, 0.5, 0.0),  # 174 Python SQLite coffee dashboard
    (0.5, 0.0, 0.0, 0.7, 0.0, 1.0),  # 175 3 fictional detectives slogans
    (0.5, 1.0, 0.7, 0.3, 1.0, 0.0),  # 176 multi-agent supply chain + math
    (0.3, 0.0, 0.0, 0.3, 0.3, 1.0),  # 177 sci-fi AI ethics auditor arc
    (1.0, 1.0, 0.5, 0.5, 0.7, 0.0),  # 178 Python autonomous stock trading
    (0.7, 0.3, 0.3, 0.7, 1.0, 0.0),  # 179 2-week data sci → ML engineer
    # edge cases 180-199
    (0.0, 0.0, 0.0, 0.0, 0.3, 0.0),  # 180 "Help me"
    (0.0, 0.3, 0.0, 0.3, 0.0, 0.0),  # 181 "why is programming so hard"
    (0.5, 0.0, 0.0, 0.5, 0.3, 0.0),  # 182 translate Chinese summarize
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.3),  # 183 emotional support
    (0.0, 0.5, 0.0, 0.5, 0.0, 0.0),  # 184 "what is python"
    (0.0, 0.3, 0.0, 0.3, 0.3, 0.0),  # 185 "best way to get better at Python"
    (0.0, 0.0, 0.0, 0.7, 0.0, 0.3),  # 186 consciousness + free will
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.0),  # 187 "Tell me a joke"
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),  # 188 "Hey! How's it going?"
    (0.0, 0.0, 0.0, 0.7, 0.0, 0.0),  # 189 le chat est noir
    (0.0, 0.0, 0.0, 0.0, 0.3, 0.0),  # 190 "help"
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),  # 191 "Hey there how's it going"
    (0.0, 0.0, 0.0, 0.0, 0.3, 0.0),  # 192 "Can you help me with this?"
    (0.0, 0.0, 0.0, 0.0, 0.3, 0.0),  # 193 "Can you help me with the project?"
    (0.0, 0.0, 0.0, 0.7, 0.0, 0.3),  # 194 free will illusion brain
    (0.0, 0.0, 0.0, 0.5, 0.0, 0.3),  # 195 stepping outside of time
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),  # 196 "hello"
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),  # 197 "Hello"
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),  # 198 "Hello"
    (0.0, 0.0, 0.0, 0.0, 0.3, 0.0),  # 199 "Could you help me with that?"
]

assert len(ANNOTATIONS) == 200, f"Expected 200 annotations, got {len(ANNOTATIONS)}"


def main() -> None:
    rows_in = []
    with IN.open() as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            rows_in.append(r)
    assert len(rows_in) == len(ANNOTATIONS), f"CSV has {len(rows_in)} rows but ANNOTATIONS has {len(ANNOTATIONS)}"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query_id", "split_type", "query"] + DIMS + ["notes"])
        for r, scores in zip(rows_in, ANNOTATIONS, strict=False):
            w.writerow([r["query_id"], r["split_type"], r["query"]] + list(scores) + ["claude_manual"])
    print(f"wrote {len(rows_in)} Claude-annotated rows to {OUT}")


if __name__ == "__main__":
    main()
