"""电影/剧集别名的不同 API 合同与无消费字段请求回归。"""

import httpx
import pytest

from app.media_v4.jobs.metadata import _extract_aliases
from app.scrape.tmdb_client import TMDBClient


def test_movie_titles_and_translations_preserve_independent_subtitle():
    detail = {
        "alternative_titles": {"titles": [{"title": "摇曳露营 剧场版"}]},
        "translations": {"translations": [{"data": {"title": "Yuru Camp Movie"}}]},
    }
    assert _extract_aliases(detail, "movie") == ["摇曳露营 剧场版", "Yuru Camp Movie"]


def test_tv_results_and_translations_deduplicate_without_changing_identity():
    detail = {
        "alternative_titles": {"results": [{"title": "房间露营"}]},
        "translations": {"translations": [{"data": {"name": "房间露营"}}]},
    }
    assert _extract_aliases(detail, "tv") == ["房间露营"]


@pytest.mark.parametrize('local_alias_present', [True, False])
def test_recovered_movie_keeps_late_tmdb_alias_as_identity_evidence(local_alias_present):
    """名称恢复只负责检索，身份等值仍须来自该 TMDB 对象的完整别名。"""
    from app.media_v4.jobs.metadata import _rank_metadata_candidates

    local_title = '福音战士新剧场版：终'
    class Client:
        def get_movie_detail(self, provider_id):
            assert provider_id == 283566
            titles = [{'title': f'Localized title {index}'} for index in range(13)]
            if local_alias_present:
                titles.append({'title': local_title})
            return {'alternative_titles': {'titles': titles}, 'genres': [{'id': 16, 'name': 'Animation'}]}

    ranked, adopted, _reason = _rank_metadata_candidates(
        {'preferred_title': local_title, 'work_type': 'movie', 'show_type': 'anime_movie',
         'recovery_search_queries': ['シン・エヴァンゲリオン劇場版:│▌']},
        'movie', ['シン・エヴァンゲリオン劇場版:│▌'],
        {'283566': {'id': 283566, 'title': '天鹰战士：最后的冲击',
                    'original_title': 'シン・エヴァンゲリオン劇場版:||', 'release_date': '2021-03-08'}},
        Client(),
    )
    assert ranked[0].identity_safe is local_alias_present
    assert (adopted is not None) is local_alias_present


def test_translated_title_survives_many_alternative_titles():
    detail = {'alternative_titles': {'titles': [{'title': f'Alias {index}'} for index in range(20)]},
              'translations': {'translations': [{'data': {'title': '本地正式标题'}}]}}
    assert '本地正式标题' in _extract_aliases(detail, 'movie')


@pytest.mark.parametrize("method,args,required", [
    ("get_tv_detail", (1,), {"images", "external_ids", "alternative_titles", "translations", "content_ratings"}),
    ("get_movie_detail", (1,), {"images", "external_ids", "alternative_titles", "translations", "release_dates"}),
    ("get_tv_season_detail", (1, 1), {"images", "external_ids", "translations"}),
    ("get_tv_episode_detail", (1, 1, 1), {"images", "external_ids", "translations"}),
])
def test_detail_request_excludes_people_but_keeps_required_metadata(method, args, required):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"id": 1})

    with httpx.Client(transport=httpx.MockTransport(respond)) as http:
        with TMDBClient(bearer_token="fixture", rate_limit=0, _http_client=http) as client:
            getattr(client, method)(*args)
    assert len(calls) == 1
    appended = set(calls[0].url.params["append_to_response"].split(","))
    assert appended == required
