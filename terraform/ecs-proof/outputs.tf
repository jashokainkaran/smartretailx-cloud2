output "alb_dns_name" {
  description = "Hit /health and /api/v1/products on this to prove the ECS/Fargate deployment works."
  value       = aws_lb.main.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.product_service.name
}
