"""Confirmed provider identity must retain independently verified aliases."""

import pytest
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.candidates import merge_graph, plan_work_candidates
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


@pytest.mark.parametrize("paths", [
    [
        "动画/咒术回战.S1-S2+剧场版（更新中）/咒术回战.[S1].2020/咒术回战.Jujutsu Kaisen.2020.S01E01.2160p.BDRip.HEVC.10bit.FLAC.ASSx2-NoxiaAI.mkv",
        "动画/[BeanSub&FZSD][Jujutsu_Kaisen][BDRip][01-47+MOVIE][CHS][1080P][MP4]/[BeanSub&FZSD][Jujutsu_Kaisen][BDRip][01][CHS][1080P][AVC_AAC](6CAAF467).mp4",
    ],
    [
        "动画/辉夜大小姐想让我告白.S1-S4+剧场版（将更新）/1.辉夜大小姐想让我告白：天才们的恋爱头脑战.[S1].2019/[YE] Kaguya-sama wa Kokurasetai꞉ Tensai-tachi no Renai Zunousen -  [01][Ma10p_2160p][x265_flac_ass].mkv",
        "动画/[LoliHouse] Kaguya-sama wa Kokurasetai - Otona e no Kaidan [WebRip 1080p HEVC-10bit AAC]/[LoliHouse] Kaguya-sama wa Kokurasetai - Otona e no Kaidan - 01 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv",
    ],
])
def test_existing_binding_does_not_discard_verified_translation(paths):
    parser = V4Parser()
    entries = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(
            root_id="verified-alias", scan_id="verified-alias", provider="pan115",
            ingest_method="directory_tree", relative_path=path,
        ))
        entries.append((evidence, parser.parse(evidence)))
    graph = MediaResolver().resolve(entries)
    candidates, initial_merges, _ = plan_work_candidates(graph, entries, lambda *_args: [])
    bindings = {
        key: [(candidate.provider, candidate.media_type, candidate.provider_id)
              for candidate in values if candidate.status == "confirmed"]
        for key, values in candidates.items()
    }
    initial = merge_graph(graph, initial_merges)
    repeated_candidates, repeated_merges, _ = plan_work_candidates(
        graph, entries, lambda *_args: [], existing_bindings=bindings,
    )
    repeated = merge_graph(graph, repeated_merges)

    assert len(initial.works) == 1
    assert len(repeated.works) == len(initial.works)
    assert {item.episode_key for item in repeated.episodes} == {item.episode_key for item in initial.episodes}
    assert all(candidate.evidence == "existing_provider_binding"
               for values in repeated_candidates.values() for candidate in values if candidate.status == "confirmed")
