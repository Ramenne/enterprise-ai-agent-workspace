"""Pure planning decisions. Never starts a machine or submits a generation."""

def choose_route(operation, demand, autodl, cloud_ready=True, original_provider=None,
                 submission_state=None, waited_seconds=0):
    if operation not in ('image', 'video_reference_image', 'video', 'train_lora'):
        raise ValueError('Unknown operation')
    if demand not in ('sporadic', 'batch'):
        raise ValueError('Demand must be sporadic or batch')
    if original_provider and submission_state in ('submitting', 'submission_unknown', 'queued', 'running'):
        return {'provider': original_provider, 'action': 'observe_original_job',
                'reason': 'never_failover_after_a_possible_submission'}
    if operation == 'video':
        return {'provider': 'comfy_cloud' if cloud_ready else None,
                'action': 'route_new_job' if cloud_ready else 'wait', 'reason': 'video_cloud_only'}
    ready = all(autodl.get(k) is True for k in (
        'running', 'health_ok', 'lease_authorized', 'within_active_window',
        'shutdown_protected', 'workflow_compatible', 'model_ready', 'lora_ready', 'capacity_available'))
    if operation == 'train_lora':
        return {'provider': 'autodl' if ready and autodl.get('training_ready') is True else None,
                'action': 'route_new_job' if ready and autodl.get('training_ready') is True else 'wait',
                'reason': 'training_autodl_only'}
    return {'provider': 'comfy_cloud' if cloud_ready else None,
            'action': 'route_new_job' if cloud_ready else 'wait',
            'reason': 'generation_cloud_only'}
