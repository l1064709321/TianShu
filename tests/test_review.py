from __future__ import annotations

import asyncio

import pytest

from tianshu.core.review.system import ReviewStatus, ReviewSystem


@pytest.mark.asyncio
async def test_manual_review_approve():
    review = ReviewSystem(mode="manual")
    req_task = asyncio.create_task(
        review.request("agent1", "write_file", {"path": "a.txt"}, reason="写文件")
    )
    await asyncio.sleep(0.05)
    assert review.pending()
    rid = review.pending()[0].id
    assert review.decide(rid, True, by="tester")
    req = await req_task
    assert req.status == ReviewStatus.APPROVED
    assert req.decided_by == "tester"
    assert review.pending() == []


@pytest.mark.asyncio
async def test_manual_review_reject():
    review = ReviewSystem(mode="manual")
    req_task = asyncio.create_task(review.request("agent1", "run_shell", {}))
    await asyncio.sleep(0.05)
    rid = review.pending()[0].id
    assert review.decide(rid, False)
    req = await req_task
    assert req.status == ReviewStatus.REJECTED


@pytest.mark.asyncio
async def test_auto_approve_mode():
    review = ReviewSystem(mode="auto_approve")
    req = await review.request("agent1", "write_file", {})
    assert req.status == ReviewStatus.APPROVED


@pytest.mark.asyncio
async def test_timeout():
    review = ReviewSystem(mode="manual")
    req = await review.request("agent1", "write_file", {}, timeout=0.1)
    assert req.status == ReviewStatus.TIMEOUT


@pytest.mark.asyncio
async def test_subscriber_notified():
    review = ReviewSystem(mode="manual")
    notified = []

    def cb(req):
        notified.append(req.id)

    review.subscribe(cb)
    task = asyncio.create_task(review.request("a", "t", {}))
    await asyncio.sleep(0.05)
    assert len(notified) == 1
    review.decide(notified[0], True)
    await task