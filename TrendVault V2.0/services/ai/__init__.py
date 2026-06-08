"""Central AI Task Router package.

Every AI-powered feature in the studio (prompt improvement, category/subject/
topic generation, script extend/regenerate) flows through ONE router instead of
each page calling a bespoke endpoint with duplicated logic. See ``router.run_task``.
"""
