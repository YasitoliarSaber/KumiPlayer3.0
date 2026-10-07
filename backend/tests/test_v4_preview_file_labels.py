"""预览问题的文件标签来自当前 revision 证据，不泄露内部 evidence 标识。"""
from dataclasses import replace

from app.api import media_v4
from app.media_v4.domain.models import ResolutionIssue, SourceEvidence
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def test_preview_issues_include_actual_filename_and_keep_each_reason(tmp_path):
    database = V4Database(tmp_path / "labels.db")
    database.initialize()
    service = V4RevisionService(database)
    path = "Films/Uma Musume Pretty Derby Road to the Top [1080p].mkv"
    evidence = SourceEvidence(evidence_id="ev-label", scan_id="labels", root_id="labels",
                              source_key=path, relative_path=path, entry_kind="video", provider="quark")
    graph = service.create_draft("labels", [(evidence, V4Parser().parse(evidence))])
    graph = replace(graph, issues=(ResolutionIssue("media_type_unresolved", evidence.evidence_id, "类型待核对"),
                                  ResolutionIssue("independent_title_candidate", evidence.evidence_id, "身份待核对")))
    payload = media_v4._graph_to_dict(graph, database=database, revision_id="labels")
    assert len(payload["issues"]) == len(graph.issues)
    assert all(issue["file_name"] == path.rsplit("/", 1)[-1] for issue in payload["issues"])
    assert all(issue["relative_path"] == path for issue in payload["issues"])
